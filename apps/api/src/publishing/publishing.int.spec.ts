import '../test/env/publishing';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { ServerTCP } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { NEVER, of } from 'rxjs';
import * as Y from 'yjs';
import { DocumentStateWriter, type PrismaClient } from '@collab-docs/db';
import { COLLAB_INTERNAL, PUBLIC_SLUG_PATTERN } from '@collab-docs/shared';
import { NODE_NAMES } from '@collab-docs/shared/content';
import { verifyCollabTicket } from '@collab-docs/nest';
import { createTestApp } from '../test/test-app';
import { PrismaService } from '../prisma/prisma.service';
import { statusOf } from './link-status';
import { PublishingWorkerModule } from './publishing.module';

const PASSWORD = 'correct-horse-battery';
const SECRET = 'dev-only-revalidate-secret-change-me';
const TICKET_SECRET = 'dev-only-collab-ticket-secret-change-me';
const UNKNOWN_ID = '0198d6c0-0000-7000-8000-000000000000';
const TOKEN_OF_NOBODY = 'A'.repeat(43);

interface TestUser {
  id: string;
  token: string;
  email: string;
}

interface WebCall {
  secret: string | undefined;
  tags: string[];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await wait(25);
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe('publishing', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let writer: DocumentStateWriter;
  let redis: Redis;
  let collab: ServerTCP;
  let collabUrl: string;
  let web: Server;
  let counter = 0;
  const flushed: string[] = [];
  let collabSilent = false;
  /** What the mock web app does with a revalidation request: the status code to answer, in order. */
  const webCalls: WebCall[] = [];
  let webAnswers: number[] = [];
  /** Answers of the mock page `/published/:slug` that come before the true one: a cache that still holds the old page. */
  let stalePageAnswers: number[] = [];
  const pageRequests: string[] = [];

  const http$ = () => request(app.getHttpServer());

  async function register(label: string): Promise<TestUser> {
    const email = `${label}-${Date.now()}-${counter++}@publishing-test.example`;
    const response = await http$()
      .post('/api/auth/register')
      .set('X-Forwarded-For', `10.7.${counter % 250}.${(counter * 7) % 250}`)
      .send({ email, password: PASSWORD, name: label })
      .expect(201);
    return { id: response.body.user.id, email, token: response.body.accessToken };
  }

  const as = (user: TestUser | null) => {
    const auth = <T extends request.Test>(req: T): T =>
      (user ? req.set('Authorization', `Bearer ${user.token}`) : req) as T;
    return {
      get: (path: string) => auth(http$().get(`/api${path}`)),
      post: (path: string) => auth(http$().post(`/api${path}`)),
      patch: (path: string) => auth(http$().patch(`/api${path}`)),
      delete: (path: string) => auth(http$().delete(`/api${path}`)),
    };
  };

  /** An owner with a workspace, a document, and a viewer, an editor and an outsider around it. */
  async function setup(title = 'Quarterly plan') {
    const [owner, viewer, editor, outsider] = await Promise.all(
      ['owner', 'viewer', 'editor', 'outsider'].map(register),
    );
    const workspace = await as(owner!).post('/workspaces').send({ name: 'Docs' }).expect(201);
    const workspaceId = workspace.body.id as string;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: viewer!.id, role: 'VIEWER' },
        { workspaceId, userId: editor!.id, role: 'EDITOR' },
      ],
    });
    const created = await as(owner!)
      .post(`/workspaces/${workspaceId}/documents`)
      .send({ title })
      .expect(201);
    return {
      owner: owner!,
      viewer: viewer!,
      editor: editor!,
      outsider: outsider!,
      workspaceId,
      documentId: created.body.id as string,
    };
  }

  async function writeContent(documentId: string, build: (fragment: Y.XmlFragment) => void) {
    const doc = new Y.Doc();
    build(doc.getXmlFragment('content'));
    await writer.append(documentId, Y.encodeStateAsUpdate(doc));
  }

  const paragraph = (text: string, attributes?: Record<string, unknown>) => {
    const element = new Y.XmlElement('paragraph');
    const node = new Y.XmlText();
    element.insert(0, [node]);
    node.insert(0, text, attributes);
    return element;
  };

  function publish(user: TestUser | null, documentId: string, body: object = { mode: 'VIEW' }) {
    return as(user).post(`/documents/${documentId}/public-links`).send(body);
  }

  /** The ticket endpoint is limited per address, so each call comes from an address of its own. */
  const guestTicket = (token: string) =>
    http$()
      .post(`/api/public/links/${token}/ticket`)
      .set('X-Forwarded-For', `10.70.${counter++ % 250}.${(counter * 3) % 250}`);

  const settleWeb = () => wait(900);

  beforeAll(async () => {
    const flush = new Redis(process.env.REDIS_URL as string);
    await flush.flushdb();
    flush.disconnect();
    redis = new Redis(process.env.REDIS_URL as string);

    const port = await freePort();
    collab = new ServerTCP({ host: '127.0.0.1', port });
    collab.addHandler(COLLAB_INTERNAL.flush, (data: { documentId: string }) => {
      flushed.push(data.documentId);
      return Promise.resolve(collabSilent ? NEVER : of({}));
    });
    await new Promise<void>((resolve) => collab.listen(() => resolve()));
    collabUrl = `tcp://127.0.0.1:${port}`;

    web = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/internal/revalidate') {
          const parsed = JSON.parse(body) as { tags: string[] };
          webCalls.push({
            secret: req.headers['x-revalidate-secret'] as string | undefined,
            tags: parsed.tags,
          });
          res.statusCode = webAnswers.shift() ?? 200;
        } else if (req.method === 'GET' && req.url?.startsWith('/published/')) {
          // the published page: 200 while the link is live, 404 otherwise, like the real route
          const slug = decodeURIComponent(req.url.slice('/published/'.length));
          pageRequests.push(slug);
          void prisma.publicLink
            .findFirst({
              where: { slug },
              select: {
                revokedAt: true,
                expiresAt: true,
                document: { select: { deletedAt: true } },
              },
            })
            .then((link) => {
              const live = link && statusOf(link) === 'active' && !link.document.deletedAt;
              res.statusCode = stalePageAnswers.shift() ?? (live ? 200 : 404);
              res.end('{}');
            });
          return;
        } else {
          res.statusCode = 404;
        }
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', () => resolve()));
    const webUrl = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;

    app = await createTestApp([], [PublishingWorkerModule]);
    app.get(ConfigService).set('COLLAB_INTERNAL_URL', collabUrl);
    app.get(ConfigService).set('WEB_INTERNAL_URL', webUrl);
    prisma = app.get(PrismaService, { strict: false });
    writer = new DocumentStateWriter(prisma);
  });

  beforeEach(() => {
    flushed.length = 0;
    webCalls.length = 0;
    webAnswers = [];
    stalePageAnswers = [];
    pageRequests.length = 0;
    collabSilent = false;
    app.get(ConfigService).set('COLLAB_INTERNAL_URL', collabUrl);
  });

  afterAll(async () => {
    redis.disconnect();
    await app.close();
    collab.close();
    await new Promise((resolve) => web.close(resolve));
  });

  describe('links', () => {
    it('publishes a page under a slug made of the title and keeps it for good', async () => {
      const { owner, documentId } = await setup('Quarterly plan');
      const first = await publish(owner, documentId).expect(201);
      expect(first.body).toMatchObject({
        mode: 'VIEW',
        status: 'active',
        token: null,
        flushed: true,
        expiresAt: null,
        revokedAt: null,
      });
      expect(first.body.slug).toMatch(/^quarterly-plan-[0-9a-f]{6}$/);
      expect(first.body.slug).toMatch(PUBLIC_SLUG_PATTERN);
      expect(flushed).toEqual([documentId]);

      // publishing again changes nothing
      const again = await publish(owner, documentId).expect(201);
      expect(again.body.id).toBe(first.body.id);
      expect(again.body.slug).toBe(first.body.slug);

      // renaming the document does not move the page
      await as(owner).patch(`/documents/${documentId}`).send({ title: 'Renamed' }).expect(200);
      expect((await publish(owner, documentId).expect(201)).body.slug).toBe(first.body.slug);
    });

    it('uses a neutral word when the title has nothing a slug can be made of', async () => {
      const { owner, documentId } = await setup('Плани на квартал');
      const response = await publish(owner, documentId).expect(201);
      expect(response.body.slug).toMatch(/^page-[0-9a-f]{6}$/);
    });

    it('unpublishing keeps the slug: publishing again brings back the same page address', async () => {
      const { owner, documentId } = await setup();
      const first = await publish(owner, documentId).expect(201);
      const slug = first.body.slug as string;
      await writeContent(documentId, (f) => f.insert(0, [paragraph('Hello')]));
      await http$().get(`/api/public/documents/${slug}`).expect(200);

      await as(owner).delete(`/documents/${documentId}/public-links/${first.body.id}`).expect(204);
      await http$().get(`/api/public/documents/${slug}`).expect(404);
      const listed = await as(owner).get(`/documents/${documentId}/public-links`).expect(200);
      expect(listed.body).toEqual([
        expect.objectContaining({ id: first.body.id, status: 'revoked', slug }),
      ]);

      const again = await publish(owner, documentId).expect(201);
      expect(again.body).toMatchObject({ id: first.body.id, slug, status: 'active' });
      await http$().get(`/api/public/documents/${slug}`).expect(200);
    });

    it('revoking twice is not an error', async () => {
      const { owner, documentId } = await setup();
      const link = (await publish(owner, documentId).expect(201)).body;
      await as(owner).delete(`/documents/${documentId}/public-links/${link.id}`).expect(204);
      await as(owner).delete(`/documents/${documentId}/public-links/${link.id}`).expect(204);
      await as(owner).delete(`/documents/${documentId}/public-links/${UNKNOWN_ID}`).expect(404);
    });

    it('issues a new secret each time editing by link is enabled; the previous one stops working', async () => {
      const { owner, documentId } = await setup();
      const first = (await publish(owner, documentId, { mode: 'EDIT' }).expect(201)).body;
      expect(first).toMatchObject({ mode: 'EDIT', slug: null, status: 'active', flushed: null });
      expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await http$().get(`/api/public/links/${first.token}`).expect(200);

      // only the hash is stored, and the list never shows the secret
      const stored = await prisma.publicLink.findUniqueOrThrow({ where: { id: first.id } });
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(first.token);
      const listed = await as(owner).get(`/documents/${documentId}/public-links`).expect(200);
      expect(JSON.stringify(listed.body)).not.toContain(first.token);

      const second = (await publish(owner, documentId, { mode: 'EDIT' }).expect(201)).body;
      expect(second.token).not.toBe(first.token);
      expect(second.id).not.toBe(first.id);
      await http$().get(`/api/public/links/${first.token}`).expect(404);
      await guestTicket(first.token).expect(404);
      await http$().get(`/api/public/links/${second.token}`).expect(200);

      // revoked, then enabled again: the leaked URL does not come back to life
      await as(owner).delete(`/documents/${documentId}/public-links/${second.id}`).expect(204);
      await http$().get(`/api/public/links/${second.token}`).expect(410);
      const third = (await publish(owner, documentId, { mode: 'EDIT' }).expect(201)).body;
      await http$().get(`/api/public/links/${second.token}`).expect(404);
      await http$().get(`/api/public/links/${third.token}`).expect(200);
    });

    it('keeps one link of each kind per document', async () => {
      const { owner, documentId } = await setup();
      await publish(owner, documentId).expect(201);
      await publish(owner, documentId, { mode: 'EDIT' }).expect(201);
      await publish(owner, documentId, { mode: 'EDIT' }).expect(201);
      const listed = await as(owner).get(`/documents/${documentId}/public-links`).expect(200);
      expect(listed.body.map((l: { mode: string }) => l.mode)).toEqual(['VIEW', 'EDIT']);
    });
  });

  describe('permissions', () => {
    it('lets the owner and the author manage links; a viewer or another editor cannot', async () => {
      const { owner, viewer, editor, outsider, workspaceId, documentId } = await setup();
      await publish(viewer, documentId).expect(403);
      await publish(editor, documentId).expect(403); // may edit, but did not write it and does not manage it
      await as(viewer).get(`/documents/${documentId}/public-links`).expect(403);
      await as(editor).get(`/documents/${documentId}/public-links`).expect(403);
      await publish(outsider, documentId).expect(404);
      await as(outsider).get(`/documents/${documentId}/public-links`).expect(404);
      await publish(null, documentId).expect(401);

      const link = (await publish(owner, documentId).expect(201)).body;
      await as(viewer).delete(`/documents/${documentId}/public-links/${link.id}`).expect(403);
      await as(editor)
        .patch(`/documents/${documentId}/public-links/${link.id}`)
        .send({ expiresAt: null })
        .expect(403);
      await as(outsider).delete(`/documents/${documentId}/public-links/${link.id}`).expect(404);

      // an editor does manage the documents they created themselves
      const own = await as(editor)
        .post(`/workspaces/${workspaceId}/documents`)
        .send({ title: 'Mine' })
        .expect(201);
      await publish(editor, own.body.id as string).expect(201);
    });

    it('rejects a link on a deleted or unknown document', async () => {
      const { owner, documentId } = await setup();
      await as(owner).delete(`/documents/${documentId}`).expect(204);
      await publish(owner, documentId).expect(404);
      await publish(owner, UNKNOWN_ID).expect(404);
    });

    it('limits how many links one user can create per hour, whatever address they use', async () => {
      const { owner, documentId } = await setup();
      for (let i = 0; i < 10; i++) {
        await publish(owner, documentId).set('X-Forwarded-For', `10.50.${i}.1`).expect(201);
      }
      const refused = await publish(owner, documentId)
        .set('X-Forwarded-For', '10.50.99.1')
        .expect(429);
      expect(refused.body.code).toBe('RATE_LIMITED');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

      // the budget is the user's, not the document's or the network's
      const other = await setup();
      await publish(other.owner, other.documentId).expect(201);
    });

    it('validates the request', async () => {
      const { owner, documentId } = await setup();
      for (const body of [
        {},
        { mode: 'COMMENT' },
        { mode: 'VIEW', expiresAt: 'tomorrow' },
        { mode: 'VIEW', expiresAt: '2000-01-01T00:00:00Z' }, // in the past
        { mode: 'VIEW', expiresAt: '2999-01-01T00:00:00Z' }, // too far ahead
        { mode: 'VIEW', expiresAt: '2030-02-31T00:00:00Z' }, // no such day
        { mode: 'VIEW', unknown: true },
      ]) {
        const response = await publish(owner, documentId, body).expect(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
      }
      const link = (await publish(owner, documentId).expect(201)).body;
      await as(owner)
        .patch(`/documents/${documentId}/public-links/${link.id}`)
        .send({})
        .expect(400);
      await as(owner)
        .patch(`/documents/${documentId}/public-links/${link.id}`)
        .send({ expiresAt: '2000-01-01T00:00:00Z' })
        .expect(400);
    });
  });

  describe('flushing before publishing', () => {
    it('publishes from storage when collab does not answer in time', async () => {
      const { owner, documentId } = await setup();
      collabSilent = true;
      const startedAt = Date.now();
      const response = await publish(owner, documentId).expect(201);
      expect(Date.now() - startedAt).toBeLessThan(4000);
      expect(response.body).toMatchObject({ status: 'active', flushed: false });
      await http$().get(`/api/public/documents/${response.body.slug}`).expect(200);
    });

    it('publishes from storage when collab is not running', async () => {
      const { owner, documentId } = await setup();
      app.get(ConfigService).set('COLLAB_INTERNAL_URL', 'tcp://127.0.0.1:1');
      const response = await publish(owner, documentId).expect(201);
      expect(response.body).toMatchObject({ status: 'active', flushed: false });
    });
  });

  describe('public page', () => {
    it('returns only what is allowed, and nothing that identifies a user or a workspace', async () => {
      const { owner, workspaceId, documentId } = await setup('Safe page');
      await writeContent(documentId, (fragment) => {
        const hostile = new Y.XmlElement('script');
        hostile.insert(0, [new Y.XmlText('alert(1)')]);
        const image = new Y.XmlElement('image');
        image.setAttribute('src', 'https://evil.example/pixel.png');
        image.setAttribute('onerror', 'alert(2)');
        const heading = new Y.XmlElement('heading');
        // the editor stores numbers as they are; the typings only know strings
        heading.setAttribute('level', 2 as unknown as string);
        heading.insert(0, [new Y.XmlText('A heading')]);
        fragment.insert(0, [
          heading,
          paragraph('Click me', { link: { href: 'javascript:alert(3)' } }),
          paragraph('Fine link', { link: { href: 'https://example.com/ok', target: '_top' } }),
          paragraph('<img src=x onerror=alert(4)>'),
          hostile,
          image,
        ]);
      });
      const { slug } = (await publish(owner, documentId).expect(201)).body;

      const response = await http$().get(`/api/public/documents/${slug}`).expect(200);
      const body = JSON.stringify(response.body);
      expect(Object.keys(response.body).sort()).toEqual([
        'content',
        'description',
        'title',
        'updatedAt',
      ]);
      expect(response.body.title).toBe('Safe page');
      expect(response.body.description).toContain('A heading');

      // nothing executable survives; the text of dropped nodes and of plain text stays inert text
      expect(body).not.toMatch(/javascript:/i);
      expect(body).not.toContain('evil.example');
      expect(body).not.toMatch(/"on[a-z]+"/i);
      expect(body).not.toContain('"src"');
      expect(body).toContain('https://example.com/ok');
      expect(body).toContain('noopener noreferrer nofollow ugc');
      expect(body).not.toContain('_top');

      const types = new Set<string>();
      const walk = (node: { type: string; content?: unknown[] }) => {
        types.add(node.type);
        for (const child of node.content ?? []) walk(child as typeof node);
      };
      walk(response.body.content);
      expect([...types].filter((t) => !(NODE_NAMES as readonly string[]).includes(t))).toEqual([]);

      // no user, no workspace, no email, however deep
      const owners = await prisma.user.findMany({ select: { id: true, email: true, name: true } });
      for (const user of owners.filter((u) => u.email.endsWith('@publishing-test.example'))) {
        expect(body).not.toContain(user.id);
        expect(body).not.toContain(user.email);
      }
      expect(body).not.toContain(workspaceId);
      expect(body).not.toContain(documentId);
      expect(body).not.toMatch(/userId|workspaceId|email/i);
    });

    it('is the same plain 404 for every reason the page is not available', async () => {
      const { owner, documentId } = await setup();
      const link = (await publish(owner, documentId).expect(201)).body;
      const slug = link.slug as string;
      const answers = async () => {
        const responses = await Promise.all(
          [slug, 'never-published-abc123', 'Not A Slug', 'x'.repeat(200), '..%2F..%2Fetc'].map(
            (s) => http$().get(`/api/public/documents/${s}`),
          ),
        );
        return responses.map((r) => ({
          status: r.status,
          message: r.body.message,
          code: r.body.code,
        }));
      };
      const [live, ...unknown] = await answers();
      expect(live!.status).toBe(200);
      const notAvailable = { status: 404, code: 'NOT_FOUND', message: 'Page not found' };
      expect(unknown).toEqual(unknown.map(() => notAvailable));

      // revoked
      await as(owner).delete(`/documents/${documentId}/public-links/${link.id}`).expect(204);
      expect((await answers())[0]).toEqual(notAvailable);

      // expired (the API refuses past dates, so move the expiry directly)
      await publish(owner, documentId).expect(201);
      expect((await answers())[0]!.status).toBe(200);
      await prisma.publicLink.update({
        where: { id: link.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await answers())[0]).toEqual(notAvailable);
      const listed = await as(owner).get(`/documents/${documentId}/public-links`).expect(200);
      expect(listed.body[0].status).toBe('expired');

      // published again with a later expiry
      await publish(owner, documentId, { mode: 'VIEW', expiresAt: '2999-01-01T00:00:00Z' }).expect(
        400,
      );
      const future = new Date(Date.now() + 3600_000).toISOString();
      const again = await publish(owner, documentId, { mode: 'VIEW', expiresAt: future }).expect(
        201,
      );
      expect(again.body).toMatchObject({ slug, status: 'active', expiresAt: future });
      expect((await answers())[0]!.status).toBe(200);

      // deleted document
      await as(owner).delete(`/documents/${documentId}`).expect(204);
      expect((await answers())[0]).toEqual(notAvailable);
    });

    it('does not turn an EDIT link into a page', async () => {
      const { owner, documentId } = await setup();
      const link = (await publish(owner, documentId, { mode: 'EDIT' }).expect(201)).body;
      await http$().get(`/api/public/documents/${link.token}`).expect(404);
    });
  });

  describe('public media', () => {
    async function attachment(
      workspaceId: string,
      documentId: string,
      userId: string,
      status: 'READY' | 'PENDING' = 'READY',
    ) {
      return prisma.attachment.create({
        data: {
          workspaceId,
          documentId,
          key: `ws/${workspaceId}/doc/${documentId}/${Date.now()}-${counter++}`,
          size: 10,
          mime: 'image/png',
          status,
          uploadedBy: userId,
        },
      });
    }

    it('redirects to a short-lived URL, only for an image of the published document', async () => {
      const { owner, workspaceId, documentId } = await setup();
      const second = await as(owner)
        .post(`/workspaces/${workspaceId}/documents`)
        .send({ title: 'Other' })
        .expect(201);
      const { slug } = (await publish(owner, documentId).expect(201)).body;
      const own = await attachment(workspaceId, documentId, owner.id);
      const pending = await attachment(workspaceId, documentId, owner.id, 'PENDING');
      const foreign = await attachment(workspaceId, second.body.id as string, owner.id);

      const redirect = await http$()
        .get(`/api/public/media/${own.id}?slug=${slug}`)
        .redirects(0)
        .expect(302);
      const target = new URL(redirect.headers.location as string);
      expect(target.origin).toBe('http://localhost:9000');
      expect(target.searchParams.get('X-Amz-Expires')).toBe('300');

      for (const path of [
        `/api/public/media/${pending.id}?slug=${slug}`,
        `/api/public/media/${foreign.id}?slug=${slug}`,
        `/api/public/media/${UNKNOWN_ID}?slug=${slug}`,
        `/api/public/media/not-an-id?slug=${slug}`,
        `/api/public/media/${own.id}?slug=never-published-abc123`,
      ]) {
        await http$().get(path).redirects(0).expect(404);
      }
      await http$().get(`/api/public/media/${own.id}`).expect(400);

      // gone with the page
      const link = (await as(owner).get(`/documents/${documentId}/public-links`).expect(200))
        .body[0];
      await as(owner).delete(`/documents/${documentId}/public-links/${link.id}`).expect(204);
      await http$().get(`/api/public/media/${own.id}?slug=${slug}`).redirects(0).expect(404);
    });
  });

  describe('guests with an edit link', () => {
    it('shows the state of the link and issues a ticket without a user', async () => {
      const { owner, workspaceId, documentId } = await setup('Shared draft');
      const { token, id } = (await publish(owner, documentId, { mode: 'EDIT' }).expect(201)).body;

      const state = await http$().get(`/api/public/links/${token}`).expect(200);
      expect(state.body).toEqual({
        mode: 'EDIT',
        documentId,
        title: 'Shared draft',
        expiresAt: null,
      });
      expect(JSON.stringify(state.body)).not.toContain(workspaceId);

      const issued = await guestTicket(token).expect(200);
      expect(issued.body.wsUrl).toBe('ws://localhost:4001/ws');
      const claims = await verifyCollabTicket(TICKET_SECRET, issued.body.ticket as string);
      expect(claims).toMatchObject({ docId: documentId, linkId: id });
      expect(claims.sub).toBeUndefined();
    });

    it('answers 404 for a token that was never issued, 410 once the link has ended', async () => {
      const { owner, documentId } = await setup();
      const link = (await publish(owner, documentId, { mode: 'EDIT' }).expect(201)).body;
      for (const token of [TOKEN_OF_NOBODY, 'short', `${link.token}x`]) {
        await http$().get(`/api/public/links/${token}`).expect(404);
        await guestTicket(token).expect(404);
      }

      await prisma.publicLink.update({
        where: { id: link.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const state = await http$().get(`/api/public/links/${link.token}`).expect(410);
      expect(state.body.code).toBe('LINK_EXPIRED');
      const ticket = await guestTicket(link.token).expect(410);
      expect(ticket.body.code).toBe('LINK_EXPIRED');

      // an expiry in the future makes it work again
      const future = new Date(Date.now() + 3600_000).toISOString();
      await as(owner)
        .patch(`/documents/${documentId}/public-links/${link.id}`)
        .send({ expiresAt: future })
        .expect(200);
      await guestTicket(link.token).expect(200);

      await as(owner).delete(`/documents/${documentId}/public-links/${link.id}`).expect(204);
      expect((await guestTicket(link.token).expect(410)).body.code).toBe('LINK_EXPIRED');
      await as(owner)
        .patch(`/documents/${documentId}/public-links/${link.id}`)
        .send({ expiresAt: null })
        .expect(409);
    });

    it('says the document is gone when it was deleted', async () => {
      const { owner, documentId } = await setup();
      const { token } = (await publish(owner, documentId, { mode: 'EDIT' }).expect(201)).body;
      await as(owner).delete(`/documents/${documentId}`).expect(204);
      const response = await guestTicket(token).expect(410);
      expect(response.body.code).toBe('DOCUMENT_DELETED');
    });

    it('limits tickets per address', async () => {
      const { owner, documentId } = await setup();
      const { token } = (await publish(owner, documentId, { mode: 'EDIT' }).expect(201)).body;
      const ip = `10.60.${counter++ % 250}.9`;
      for (let i = 0; i < 5; i++) {
        await http$()
          .post(`/api/public/links/${token}/ticket`)
          .set('X-Forwarded-For', ip)
          .expect(200);
      }
      const refused = await http$()
        .post(`/api/public/links/${token}/ticket`)
        .set('X-Forwarded-For', ip)
        .expect(429);
      expect(refused.body.code).toBe('RATE_LIMITED');
      await http$()
        .post(`/api/public/links/${token}/ticket`)
        .set('X-Forwarded-For', '10.61.0.1')
        .expect(200);
    });

    it('tells collab when the link ends, so open guest sockets do not wait for the next check', async () => {
      const { owner, workspaceId, documentId } = await setup();
      const subscriber = new Redis(process.env.REDIS_URL as string);
      const events: Array<Record<string, unknown>> = [];
      subscriber.on('message', (_channel, raw) => {
        const event = JSON.parse(raw) as Record<string, unknown>;
        if (event.workspaceId === workspaceId) events.push(event);
      });
      await subscriber.subscribe('perm.changed');
      try {
        const soon = new Date(Date.now() + 2000).toISOString();
        const link = (
          await publish(owner, documentId, { mode: 'EDIT', expiresAt: soon }).expect(201)
        ).body;
        await guestTicket(link.token).expect(200);
        expect(events).toEqual([]);
        await until(() => events.length === 1, 8000);
        expect(events[0]).toMatchObject({ reason: 'link_changed', documentId });
        await guestTicket(link.token).expect(410);
      } finally {
        subscriber.disconnect();
      }
    });

    it('cuts off the sockets of the old link as soon as it is replaced or revoked', async () => {
      const { owner, workspaceId, documentId } = await setup();
      const subscriber = new Redis(process.env.REDIS_URL as string);
      const events: Array<Record<string, unknown>> = [];
      subscriber.on('message', (_channel, raw) => {
        const event = JSON.parse(raw) as Record<string, unknown>;
        if (event.workspaceId === workspaceId) events.push(event);
      });
      await subscriber.subscribe('perm.changed');
      try {
        const first = (await publish(owner, documentId, { mode: 'EDIT' }).expect(201)).body;
        await wait(200);
        expect(events).toEqual([]); // nothing to cut off yet
        const second = (await publish(owner, documentId, { mode: 'EDIT' }).expect(201)).body;
        await until(() => events.length === 1);
        await as(owner).delete(`/documents/${documentId}/public-links/${second.id}`).expect(204);
        await until(() => events.length === 2);
        expect(events).toEqual([
          expect.objectContaining({ documentId, reason: 'link_changed' }),
          expect.objectContaining({ documentId, reason: 'link_changed' }),
        ]);
        expect(first.id).not.toBe(second.id);
      } finally {
        subscriber.disconnect();
      }
    });
  });

  describe('page revalidation', () => {
    it('turns a burst of changes into one call with the secret and the tag of the page', async () => {
      const { owner, documentId } = await setup('First title');
      const { slug } = (await publish(owner, documentId).expect(201)).body;
      await until(() => webCalls.length >= 1); // the publish itself
      await settleWeb();
      webCalls.length = 0;

      await Promise.all(
        [0, 1, 2, 3, 4, 5].map((i) =>
          as(owner)
            .patch(`/documents/${documentId}`)
            .send({ title: `Title ${i}` })
            .expect(200),
        ),
      );
      await until(() => webCalls.length >= 1);
      await settleWeb();
      expect(webCalls).toEqual([{ secret: SECRET, tags: [`pub:${slug}`] }]);
    });

    it('revalidates after a title change of a published document, and not for an unpublished one', async () => {
      const published = await setup('Renamed');
      const { slug } = (await publish(published.owner, published.documentId).expect(201)).body;
      await until(() => webCalls.length >= 1);
      await settleWeb();
      webCalls.length = 0;

      await as(published.owner)
        .patch(`/documents/${published.documentId}`)
        .send({ title: 'Brand new title' })
        .expect(200);
      await until(() => webCalls.length === 1);
      expect(webCalls[0]!.tags).toEqual([`pub:${slug}`]);
      const page = await http$().get(`/api/public/documents/${slug}`).expect(200);
      expect(page.body.title).toBe('Brand new title');

      const private_ = await setup('Never published');
      await as(private_.owner)
        .patch(`/documents/${private_.documentId}`)
        .send({ title: 'Still private' })
        .expect(200);
      await wait(1000);
      expect(webCalls).toHaveLength(1);
    });

    it('revalidates when the page is published, unpublished and deleted, without waiting for a debounce', async () => {
      const { owner, documentId } = await setup();
      const link = (await publish(owner, documentId).expect(201)).body;
      await until(() => webCalls.length === 1);
      await as(owner).delete(`/documents/${documentId}/public-links/${link.id}`).expect(204);
      await until(() => webCalls.length === 2);
      await publish(owner, documentId).expect(201);
      await until(() => webCalls.length === 3);
      await settleWeb();
      webCalls.length = 0;
      await as(owner).delete(`/documents/${documentId}`).expect(204);
      await until(() => webCalls.length === 1);
      expect(webCalls[0]!.tags).toEqual([`pub:${link.slug}`]);
    });

    it('invalidates again while the web app still serves an unpublished page', async () => {
      const { owner, documentId } = await setup();
      const link = (await publish(owner, documentId).expect(201)).body;
      await until(() => webCalls.length === 1);
      await settleWeb();
      webCalls.length = 0;
      pageRequests.length = 0;

      // the cache answers with the old page once, as it does when a render finishes after the invalidation
      stalePageAnswers = [200];
      await as(owner).delete(`/documents/${documentId}/public-links/${link.id}`).expect(204);
      await until(() => webCalls.length >= 2, 12_000);
      await settleWeb();
      expect(webCalls).toEqual(Array(2).fill({ secret: SECRET, tags: [`pub:${link.slug}`] }));
      expect(pageRequests).toEqual([link.slug, link.slug]);
    });

    it('invalidates again while the web app still serves the cached 404 of a published page', async () => {
      const { owner, documentId } = await setup();
      stalePageAnswers = [404];
      const { slug } = (await publish(owner, documentId).expect(201)).body;
      await until(() => webCalls.length >= 2, 12_000);
      await settleWeb();
      expect(webCalls).toEqual(Array(2).fill({ secret: SECRET, tags: [`pub:${slug}`] }));
    });

    it('tries again when the web app fails', async () => {
      const { owner, documentId } = await setup();
      webAnswers = [500, 503];
      const { slug } = (await publish(owner, documentId).expect(201)).body;
      await until(() => webCalls.length >= 3, 12_000);
      await settleWeb();
      expect(webCalls).toEqual(Array(3).fill({ secret: SECRET, tags: [`pub:${slug}`] }));
    });

    it('revalidates a page whose link expires, when it expires', async () => {
      const { owner, documentId } = await setup();
      const soon = new Date(Date.now() + 3000).toISOString();
      const { slug } = (
        await publish(owner, documentId, { mode: 'VIEW', expiresAt: soon }).expect(201)
      ).body;
      await until(() => webCalls.length === 1); // the publish
      await settleWeb();
      webCalls.length = 0;
      await until(() => webCalls.length === 1, 8000);
      expect(webCalls[0]!.tags).toEqual([`pub:${slug}`]);
      await http$().get(`/api/public/documents/${slug}`).expect(404);
    });

    it('ignores the planned expiry once the expiry was moved', async () => {
      const { owner, documentId } = await setup();
      const soon = new Date(Date.now() + 3000).toISOString();
      const link = (await publish(owner, documentId, { mode: 'VIEW', expiresAt: soon }).expect(201))
        .body;
      await until(() => webCalls.length === 1);
      await settleWeb();
      webCalls.length = 0;
      await as(owner)
        .patch(`/documents/${documentId}/public-links/${link.id}`)
        .send({ expiresAt: null })
        .expect(200);
      await wait(3000);
      expect(webCalls).toEqual([]);
      await http$().get(`/api/public/documents/${link.slug}`).expect(200);
    });
  });

  // last on purpose: it leaves the web app unreachable, and the retries of its jobs keep going
  describe('a web app that is down', () => {
    it('never holds up editing or publishing', async () => {
      const { owner, documentId } = await setup();
      await publish(owner, documentId).expect(201);
      app.get(ConfigService).set('WEB_INTERNAL_URL', 'http://127.0.0.1:1');
      const started = Date.now();
      await as(owner)
        .patch(`/documents/${documentId}`)
        .send({ title: 'Edited while the web app is down' })
        .expect(200);
      await publish(owner, documentId, { mode: 'EDIT' }).expect(201);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
