import '../test/security-env';
import http from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { ServerTCP } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import { of } from 'rxjs';
import { COLLAB_INTERNAL } from '@collab-docs/shared';
import { PrismaService } from '../prisma/prisma.service';
import { buildOpenApiDocument } from '../swagger';
import { createTestApp } from '../test/test-app';
import { Fixture, PERSONAS, Resources, VARIANTS, type PersonaName, type Variant } from './fixture';
import { IDOR_TABLE, expectedStatus, type Call } from './idor-table';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const METHODS = ['get', 'post', 'patch', 'delete'] as const;

/** Every operation of the OpenAPI document as `METHOD /path/{param}`. */
function documentedRoutes(app: NestExpressApplication): string[] {
  const document = buildOpenApiDocument(app);
  const routes: string[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      if (item[method]) routes.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes.sort();
}

describe('IDOR matrix', () => {
  let app: NestExpressApplication;
  let fixture: Fixture;
  let collab: ServerTCP;
  let baseUrl: string;

  beforeAll(async () => {
    const flush = new Redis(process.env.REDIS_URL as string);
    await flush.flushdb();
    flush.disconnect();

    // versions are written by the collab service; any answer will do for the authorisation question
    const port = await freePort();
    collab = new ServerTCP({ host: '127.0.0.1', port });
    for (const pattern of [COLLAB_INTERNAL.flush, COLLAB_INTERNAL.restore]) {
      collab.addHandler(pattern, () => Promise.resolve(of({})));
    }
    await new Promise<void>((resolve) => collab.listen(() => resolve()));

    app = await createTestApp([]);
    app.get(ConfigService).set('COLLAB_INTERNAL_URL', `tcp://127.0.0.1:${port}`);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    fixture = await Fixture.create(app, app.get(PrismaService, { strict: false }));
  });

  // members and invites that rows make come and go, but the plan limits seats: start every row from the base
  afterEach(async () => {
    const base = Object.values(fixture.personas)
      .map((persona) => persona.id)
      .filter((id): id is string => id !== undefined);
    await fixture.prisma.workspaceMember.deleteMany({
      where: { workspaceId: fixture.workspaceId, userId: { notIn: base } },
    });
    await fixture.prisma.workspaceInvite.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
  });

  afterAll(async () => {
    await app.close();
    collab.close();
  });

  /** Fills the placeholders of the route and sends the request as the persona. */
  async function send(route: string, call: Call, persona: PersonaName): Promise<number> {
    const [method, template] = route.split(' ') as [string, string];
    const path = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
      const value = call.params?.[name];
      if (value === undefined) throw new Error(`${route}: no value for {${name}}`);
      return encodeURIComponent(value);
    });
    const token = fixture.personas[persona].token;
    const query = call.query ? `?${new URLSearchParams(call.query)}` : '';
    if (call.stream) return streamStatus(`${path}${query}`, token);
    const req = fixture
      .call(method.toLowerCase() as (typeof METHODS)[number], path, token)
      .query(call.query ?? {});
    // a redirect is the answer of GET /auth/refresh, not something to follow
    const response = await (call.body ? req.send(call.body) : req).redirects(0);
    return response.status;
  }

  /** An event stream never ends: the status line is all there is to read. */
  function streamStatus(path: string, token: string | undefined): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `${baseUrl}${path}`,
        {
          headers: token ? { Authorization: `Bearer ${token}`, 'X-Forwarded-For': '10.9.9.9' } : {},
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
      });
    });
  }

  /**
   * The classic IDOR: the caller owns a workspace and a document of their own, passes a path that is theirs, and
   * swaps one id for an id of somebody else's. Authorisation has to follow the object the id names.
   */
  describe('ids of another tenant', () => {
    let attacker: { token: string; workspaceId: string; documentId: string; slug: string };
    let victim: Resources;

    beforeAll(async () => {
      const token = fixture.personas.outsider.token as string;
      const workspace = await fixture
        .call('post', '/api/workspaces', token)
        .send({ name: 'Mine' })
        .expect(201);
      const workspaceId = workspace.body.id as string;
      const documentId = await fixture.createDocument(token, workspaceId, 'open');
      const link = await fixture
        .call('post', `/api/documents/${documentId}/public-links`, token)
        .send({ mode: 'VIEW' })
        .expect(201);
      attacker = { token, workspaceId, documentId, slug: link.body.slug as string };
      victim = new Resources(fixture, 'open');
    });

    const asAttacker = (method: (typeof METHODS)[number], path: string) =>
      fixture.call(method, path, attacker.token);

    it('does not hand out a version through a document of one’s own', async () => {
      const { versionId } = await victim.version();
      const mine = `/api/documents/${attacker.documentId}/versions/${versionId}`;
      expect((await asAttacker('get', mine)).status).toBe(404);
      expect((await asAttacker('post', `${mine}/restore`)).status).toBe(404);
    });

    it('does not touch a public link of another document', async () => {
      const { linkId } = await victim.linked();
      const mine = `/api/documents/${attacker.documentId}/public-links/${linkId}`;
      expect((await asAttacker('patch', mine).send({ expiresAt: null })).status).toBe(404);
      expect((await asAttacker('delete', mine)).status).toBe(404);
    });

    it('does not touch the share of another document', async () => {
      const { userId } = await victim.sharedWithSpare();
      const mine = `/api/documents/${attacker.documentId}/shares/${userId}`;
      expect((await asAttacker('patch', mine).send({ role: 'EDITOR' })).status).toBe(404);
      expect((await asAttacker('delete', mine)).status).toBe(404);
    });

    it('does not sign, complete or publish the attachment of another document', async () => {
      const { attachmentId } = await victim.attachment();
      expect((await asAttacker('get', `/api/attachments/${attachmentId}/url`)).status).toBe(404);
      expect((await asAttacker('post', `/api/attachments/${attachmentId}/complete`)).status).toBe(
        404,
      );
      // the media route of a page the caller published must not serve images of other documents
      const media = await fixture
        .http()
        .get(`/api/public/media/${attachmentId}`)
        .query({ slug: attacker.slug })
        .redirects(0);
      expect(media.status).toBe(404);
    });

    it('does not read or write into the thread of another document', async () => {
      const { threadId, commentId } = await victim.thread();
      expect(
        (await asAttacker('post', `/api/threads/${threadId}/comments`).send({ body: 'hi' })).status,
      ).toBe(404);
      expect((await asAttacker('post', `/api/threads/${threadId}/resolve`)).status).toBe(404);
      expect(
        (await asAttacker('patch', `/api/comments/${commentId}`).send({ body: 'hi' })).status,
      ).toBe(404);
      expect((await asAttacker('delete', `/api/comments/${commentId}`)).status).toBe(404);
    });

    it('does not touch the members and invites of another workspace through a workspace of one’s own', async () => {
      const inviteId = await victim.invite();
      const memberId = fixture.personas.viewer.id as string;
      const mine = `/api/workspaces/${attacker.workspaceId}`;
      expect((await asAttacker('delete', `${mine}/invites/${inviteId}`)).status).toBe(404);
      expect(
        (await asAttacker('patch', `${mine}/members/${memberId}`).send({ role: 'ADMIN' })).status,
      ).toBe(404);
      expect((await asAttacker('delete', `${mine}/members/${memberId}`)).status).toBe(404);
    });

    it('does not move or create a document under a parent of another workspace', async () => {
      const foreign = victim.document;
      const move = await asAttacker('post', `/api/documents/${attacker.documentId}/move`).send({
        parentId: foreign,
      });
      expect(move.status).toBe(404);
      const create = await asAttacker(
        'post',
        `/api/workspaces/${attacker.workspaceId}/documents`,
      ).send({ title: 'X', parentId: foreign });
      expect(create.status).toBe(404);
    });
  });

  it('has a decision for every route, and no decision for a route that does not exist', () => {
    const routes = documentedRoutes(app);
    const decided = Object.keys(IDOR_TABLE).sort();
    expect(routes.filter((route) => !(route in IDOR_TABLE))).toEqual([]);
    expect(decided.filter((route) => !routes.includes(route))).toEqual([]);
  });

  describe.each(Object.entries(IDOR_TABLE))('%s', (route, row) => {
    // the variant matters only where a document decides
    const variants: readonly Variant[] =
      row.once || ['workspace', 'authenticated', 'open', 'link'].includes(row.policy.kind)
        ? ['open']
        : VARIANTS;
    it.each(variants)(`answers every persona as the table says (%s document)`, async (variant) => {
      const resources = new Resources(fixture, variant);
      const got: Record<string, number> = {};
      const want: Record<string, number> = {};
      // the allowed personas come last: the order does not matter, because every call gets fresh resources
      for (const persona of PERSONAS) {
        const call = await row.call(resources, fixture.personas[persona], fixture);
        got[persona] = await send(route, call, persona);
        want[persona] = expectedStatus(row.policy, persona, variant);
      }
      expect(got).toEqual(want);
    });
  });
});
