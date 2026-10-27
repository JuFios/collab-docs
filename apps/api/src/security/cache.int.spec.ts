import '../test/security-env';
import { createServer, type AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { ServerTCP } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import type request from 'supertest';
import { of } from 'rxjs';
import { COLLAB_INTERNAL } from '@collab-docs/shared';
import { QUEUE_NAMES, QueueService } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';
import { buildOpenApiDocument } from '../swagger';
import { createTestApp } from '../test/test-app';
import { Fixture, Resources } from './fixture';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

interface Setup {
  /** The document the mutation is aimed at; it has a published page unless `unpublished` is set. */
  documentId: string;
  /** Anything the mutation needs besides the document (a share, a link). */
  extra: { userId?: string; linkId?: string };
}

interface Mutation {
  /** The route, as in the OpenAPI document. */
  route: string;
  /** What the call changes, when the route does several things. */
  what: string;
  /** The tree of the workspace is cached: the call has to orphan the cached copy. */
  tree: boolean;
  /** The public page of the document is cached by the web app: the call has to ask for it to be rebuilt. */
  page: boolean;
  unpublished?: boolean;
  /** The page stays as it is until then; the expiry job rebuilds it when the link ends. */
  plannedExpiry?: boolean;
  /** Put the document in the state the call expects (trash, a share, a link). */
  prepare?: (r: Resources, setup: Setup, f: Fixture) => Promise<void>;
  call: (f: Fixture, setup: Setup, token: string) => PromiseLike<request.Response>;
}

const owner = (f: Fixture) => f.owner.token as string;

/**
 * Every call that changes a document, with what has to follow. A new route under `/documents` that is missing from
 * here fails the suite, so a mutation cannot be added without deciding what it must invalidate.
 */
const MUTATIONS: Mutation[] = [
  {
    route: 'POST /api/workspaces/{workspaceId}/documents',
    what: 'create',
    tree: true,
    page: false,
    call: (f, _s, t) =>
      f.call('post', `/api/workspaces/${f.workspaceId}/documents`, t).send({ title: 'New' }),
  },
  {
    route: 'PATCH /api/documents/{id}',
    what: 'title',
    tree: true,
    page: true,
    call: (f, s, t) =>
      f.call('patch', `/api/documents/${s.documentId}`, t).send({ title: 'Renamed' }),
  },
  {
    route: 'PATCH /api/documents/{id}',
    what: 'icon',
    tree: true,
    page: true,
    call: (f, s, t) => f.call('patch', `/api/documents/${s.documentId}`, t).send({ icon: '📄' }),
  },
  {
    route: 'PATCH /api/documents/{id}',
    what: 'visibility',
    tree: true,
    page: false,
    call: (f, s, t) =>
      f.call('patch', `/api/documents/${s.documentId}`, t).send({ visibility: 'RESTRICTED' }),
  },
  {
    route: 'POST /api/documents/{id}/move',
    what: 'move',
    tree: true,
    page: false,
    call: (f, s, t) =>
      f.call('post', `/api/documents/${s.documentId}/move`, t).send({ parentId: null }),
  },
  {
    route: 'DELETE /api/documents/{id}',
    what: 'delete',
    tree: true,
    page: true,
    call: (f, s, t) => f.call('delete', `/api/documents/${s.documentId}`, t),
  },
  {
    route: 'POST /api/documents/{id}/restore',
    what: 'restore',
    tree: true,
    page: true,
    prepare: async (_r, s, f) => {
      await f.call('delete', `/api/documents/${s.documentId}`, owner(f)).expect(204);
    },
    call: (f, s, t) => f.call('post', `/api/documents/${s.documentId}/restore`, t),
  },
  {
    route: 'POST /api/documents/{id}/shares',
    what: 'share',
    tree: true,
    page: false,
    call: (f, s, t) =>
      f
        .call('post', `/api/documents/${s.documentId}/shares`, t)
        .send({ email: f.spare.email, role: 'VIEWER' }),
  },
  {
    route: 'PATCH /api/documents/{id}/shares/{userId}',
    what: 'share role',
    tree: true,
    page: false,
    prepare: async (_r, s, f) => f.share(owner(f), s.documentId, f.spare.email, 'VIEWER'),
    call: (f, s, t) =>
      f
        .call('patch', `/api/documents/${s.documentId}/shares/${f.spare.id}`, t)
        .send({ role: 'EDITOR' }),
  },
  {
    route: 'DELETE /api/documents/{id}/shares/{userId}',
    what: 'unshare',
    tree: true,
    page: false,
    prepare: async (_r, s, f) => f.share(owner(f), s.documentId, f.spare.email, 'VIEWER'),
    call: (f, s, t) => f.call('delete', `/api/documents/${s.documentId}/shares/${f.spare.id}`, t),
  },
  {
    route: 'POST /api/documents/{id}/public-links',
    what: 'publish',
    tree: false,
    page: true,
    unpublished: true,
    call: (f, s, t) =>
      f.call('post', `/api/documents/${s.documentId}/public-links`, t).send({ mode: 'VIEW' }),
  },
  {
    route: 'PATCH /api/documents/{id}/public-links/{linkId}',
    what: 'expiry',
    tree: false,
    page: false,
    plannedExpiry: true,
    call: (f, s, t) =>
      f
        .call('patch', `/api/documents/${s.documentId}/public-links/${s.extra.linkId}`, t)
        .send({ expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
  },
  {
    route: 'DELETE /api/documents/{id}/public-links/{linkId}',
    what: 'unpublish',
    tree: false,
    page: true,
    call: (f, s, t) =>
      f.call('delete', `/api/documents/${s.documentId}/public-links/${s.extra.linkId}`, t),
  },
  // changes that neither list nor page show
  {
    route: 'POST /api/documents/{id}/versions',
    what: 'snapshot',
    tree: false,
    page: false,
    call: (f, s, t) =>
      f.call('post', `/api/documents/${s.documentId}/versions`, t).send({ label: 'Mark' }),
  },
  {
    route: 'POST /api/documents/{id}/versions/{versionId}/restore',
    what: 'restore a version',
    // collab replaces the content and reports it as an edit; the api itself changes nothing a cache holds
    tree: false,
    page: false,
    call: async (f, s, t) => {
      const row = await f.prisma.documentVersion.create({
        data: {
          documentId: s.documentId,
          state: Buffer.from([0, 0]),
          kind: 'MANUAL',
          title: 'Doc',
        },
      });
      return f.call('post', `/api/documents/${s.documentId}/versions/${row.id}/restore`, t);
    },
  },
  {
    route: 'POST /api/documents/{id}/attachments/presign',
    what: 'upload',
    tree: false,
    page: false,
    call: (f, s, t) =>
      f
        .call('post', `/api/documents/${s.documentId}/attachments/presign`, t)
        .send({ filename: 'a.png', mime: 'image/png', size: 10 }),
  },
  {
    route: 'POST /api/documents/{id}/threads',
    what: 'comment',
    tree: false,
    page: false,
    call: (f, s, t) =>
      f
        .call('post', `/api/documents/${s.documentId}/threads`, t)
        .send({ blockId: 'block-1', body: 'Hm' }),
  },
  {
    route: 'POST /api/documents/{id}/collab-ticket',
    what: 'ticket',
    tree: false,
    page: false,
    call: (f, s, t) => f.call('post', `/api/documents/${s.documentId}/collab-ticket`, t),
  },
];

describe('caches follow the data', () => {
  let app: NestExpressApplication;
  let fixture: Fixture;
  let redis: Redis;
  let collab: ServerTCP;
  let queues: QueueService;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL as string);
    const port = await freePort();
    collab = new ServerTCP({ host: '127.0.0.1', port });
    for (const pattern of [COLLAB_INTERNAL.flush, COLLAB_INTERNAL.restore]) {
      collab.addHandler(pattern, () => Promise.resolve(of({})));
    }
    await new Promise<void>((resolve) => collab.listen(() => resolve()));

    // no worker: the jobs the api enqueues stay where the test can count them
    app = await createTestApp([]);
    app.get(ConfigService).set('COLLAB_INTERNAL_URL', `tcp://127.0.0.1:${port}`);
    queues = app.get(QueueService, { strict: false });
    fixture = await Fixture.create(app, app.get(PrismaService, { strict: false }));
  });

  afterAll(async () => {
    redis.disconnect();
    await app.close();
    collab.close();
  });

  it('has a rule for every route that changes a document', () => {
    const document = buildOpenApiDocument(app);
    const mutating = Object.entries(document.paths)
      .filter(([path]) => path.startsWith('/api/documents/') || path.endsWith('/documents'))
      .flatMap(([path, item]) =>
        (['post', 'patch', 'delete', 'put'] as const)
          .filter((method) => item[method])
          .map((method) => `${method.toUpperCase()} ${path}`),
      );
    const covered = new Set(MUTATIONS.map((mutation) => mutation.route));
    expect(mutating.filter((route) => !covered.has(route))).toEqual([]);
    expect([...covered].filter((route) => !mutating.includes(route))).toEqual([]);
  });

  /** Page-rebuild jobs waiting for a document. */
  async function pageJobs(documentId: string) {
    const jobs = await queues
      .getQueue(QUEUE_NAMES.publicRevalidate)
      .getJobs(['delayed', 'waiting', 'active']);
    return jobs.filter((job) => job.data.documentId === documentId);
  }

  it.each(MUTATIONS.map((m) => [`${m.route} (${m.what})`, m] as const))(
    '%s',
    async (_name, mutation) => {
      const r = new Resources(fixture, 'open');
      const token = owner(fixture);
      const documentId = await r.fresh();
      const setup: Setup = { documentId, extra: {} };
      if (!mutation.unpublished) {
        const link = await fixture
          .call('post', `/api/documents/${documentId}/public-links`, token)
          .send({ mode: 'VIEW' })
          .expect(201);
        setup.extra.linkId = link.body.id as string;
      }
      await mutation.prepare?.(r, setup, fixture);
      // start from a quiet queue: whatever the preparation announced is not what the call is judged by
      for (const job of await pageJobs(documentId)) await job.remove();

      const versionKey = `tree:ver:${fixture.workspaceId}`;
      const before = Number((await redis.get(versionKey)) ?? 0);
      const response = await mutation.call(fixture, setup, token);
      expect(response.status).toBeLessThan(300);

      const after = Number((await redis.get(versionKey)) ?? 0);
      expect(after - before).toBe(mutation.tree ? 1 : 0);
      expect((await pageJobs(documentId)).length > 0).toBe(mutation.page);
      const expiryJobs = (
        await queues.getQueue(QUEUE_NAMES.linkExpiry).getJobs(['delayed', 'waiting'])
      ).filter((job) => job.data.linkId === setup.extra.linkId);
      expect(expiryJobs.length > 0).toBe(mutation.plannedExpiry === true);
    },
  );
});
