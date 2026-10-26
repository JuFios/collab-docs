import '../test/versions-env';
import { ConfigService } from '@nestjs/config';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import * as Y from 'yjs';
import {
  DocumentStateWriter,
  DocumentVersions,
  MAX_VERSIONS,
  type PrismaClient,
} from '@collab-docs/db';
import { QUEUE_NAMES, QueueService, parseConfig } from '@collab-docs/nest';
import { createTestApp } from '../test/test-app';
import { VersionPruneProcessor } from './version-prune.processor';
import { VersionsWorkerModule } from './versions.module';
import { PrismaService } from '../prisma/prisma.service';

const PASSWORD = 'correct-horse-battery';
const UNKNOWN_ID = '0198d6c0-0000-7000-8000-000000000000';

interface TestUser {
  id: string;
  token: string;
  email: string;
}

interface RecordedCall {
  path: string;
  authorization?: string;
  body: unknown;
}

describe('document versions', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let versions: DocumentVersions;
  let writer: DocumentStateWriter;
  let redis: Redis;
  let collab: http.Server;
  let collabUrl: string;
  let counter = 0;
  const calls: RecordedCall[] = [];
  let collabStatus = 200;
  let collabBody: object = {};

  const http$ = () => request(app.getHttpServer());

  async function register(label: string): Promise<TestUser> {
    const email = `${label}-${Date.now()}-${counter++}@versions-test.example`;
    const response = await http$()
      .post('/api/auth/register')
      .set('X-Forwarded-For', `10.9.${counter % 250}.${(counter * 7) % 250}`)
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
    };
  };

  async function setup() {
    const [owner, viewer, outsider] = await Promise.all(
      ['owner', 'viewer', 'outsider'].map(register),
    );
    const workspace = await as(owner!).post('/workspaces').send({ name: 'Docs' }).expect(201);
    const workspaceId = workspace.body.id as string;
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: viewer!.id, role: 'VIEWER' },
    });
    const created = await as(owner!)
      .post(`/workspaces/${workspaceId}/documents`)
      .send({ title: 'Plan' })
      .expect(201);
    return {
      owner: owner!,
      viewer: viewer!,
      outsider: outsider!,
      documentId: created.body.id as string,
    };
  }

  /** Puts content straight into storage, the way the collab service would have. */
  async function writeContent(documentId: string, text: string, extra?: (doc: Y.Doc) => void) {
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment('content').insert(0, [paragraph]);
    extra?.(doc);
    await writer.append(documentId, Y.encodeStateAsUpdate(doc));
  }

  beforeAll(async () => {
    const flush = new Redis(process.env.REDIS_URL as string);
    await flush.flushdb();
    flush.disconnect();
    redis = new Redis(process.env.REDIS_URL as string);

    collab = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        calls.push({
          path: req.url ?? '',
          authorization: req.headers.authorization,
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(collabStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(collabBody));
      });
    });
    await new Promise<void>((resolve) => collab.listen(0, '127.0.0.1', resolve));
    collabUrl = `http://127.0.0.1:${(collab.address() as AddressInfo).port}`;

    app = await createTestApp([], [VersionsWorkerModule]);
    // the client reads the url from the shared config object on every call
    app.get(ConfigService).set('COLLAB_INTERNAL_URL', collabUrl);
    prisma = app.get(PrismaService, { strict: false });
    versions = app.get(DocumentVersions, { strict: false });
    writer = new DocumentStateWriter(prisma);
  });

  beforeEach(() => {
    calls.length = 0;
    collabStatus = 200;
    collabBody = {};
    app.get(ConfigService).set('COLLAB_INTERNAL_URL', collabUrl);
  });

  afterAll(async () => {
    redis.disconnect();
    await app.close();
    await new Promise((resolve) => collab.close(resolve));
  });

  describe('permissions', () => {
    it('lets anyone who can read the document list and open versions, but only editors write', async () => {
      const { owner, viewer, outsider, documentId } = await setup();
      await writeContent(documentId, 'hello');
      const created = await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({})
        .expect(201);
      const versionId = created.body.id as string;

      for (const reader of [owner, viewer]) {
        await as(reader).get(`/documents/${documentId}/versions`).expect(200);
        await as(reader).get(`/documents/${documentId}/versions/${versionId}`).expect(200);
      }
      await as(viewer).post(`/documents/${documentId}/versions`).send({}).expect(403);
      await as(viewer).post(`/documents/${documentId}/versions/${versionId}/restore`).expect(403);

      for (const path of [
        { m: 'get', p: `/documents/${documentId}/versions` },
        { m: 'get', p: `/documents/${documentId}/versions/${versionId}` },
        { m: 'post', p: `/documents/${documentId}/versions` },
        { m: 'post', p: `/documents/${documentId}/versions/${versionId}/restore` },
      ] as const) {
        await (as(outsider)[path.m](path.p) as request.Test).expect(404);
        await (as(null)[path.m](path.p) as request.Test).expect(401);
      }
    });

    it('answers 404 for a deleted document', async () => {
      const { owner, documentId } = await setup();
      await as(owner).post(`/documents/${documentId}/versions`).send({}).expect(201);
      await http$()
        .delete(`/api/documents/${documentId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);
      await as(owner).get(`/documents/${documentId}/versions`).expect(404);
    });
  });

  describe('saving a version', () => {
    it('asks collab to write its buffer first, then snapshots the stored content', async () => {
      const { owner, documentId } = await setup();
      await writeContent(documentId, 'saved text');
      const response = await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({ label: '  Before review  ' })
        .expect(201);
      expect(response.body).toMatchObject({
        kind: 'MANUAL',
        label: 'Before review',
        title: 'Plan',
        flushed: true,
        author: { id: owner.id },
      });
      expect(calls).toEqual([
        {
          path: `/internal/documents/${documentId}/flush`,
          authorization: `Bearer ${parseConfig(process.env).INTERNAL_API_TOKEN}`,
          body: {},
        },
      ]);

      const detail = await as(owner)
        .get(`/documents/${documentId}/versions/${response.body.id}`)
        .expect(200);
      expect(detail.body.content).toEqual({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'saved text' }] }],
      });
    });

    it('still saves, and says so, when collab cannot be reached', async () => {
      const { owner, documentId } = await setup();
      await writeContent(documentId, 'stored');
      app.get(ConfigService).set('COLLAB_INTERNAL_URL', 'http://127.0.0.1:1');
      const response = await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({})
        .expect(201);
      expect(response.body.flushed).toBe(false);
      expect(response.body.label).toBeNull();
    });

    it('still saves when collab refuses the flush', async () => {
      const { owner, documentId } = await setup();
      collabStatus = 500;
      const response = await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({})
        .expect(201);
      expect(response.body.flushed).toBe(false);
    });

    it('snapshots an empty document', async () => {
      const { owner, documentId } = await setup();
      const created = await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({})
        .expect(201);
      const detail = await as(owner)
        .get(`/documents/${documentId}/versions/${created.body.id}`)
        .expect(200);
      expect(detail.body.content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    });

    it('validates the label and refuses a 101st saved version', async () => {
      const { owner, documentId } = await setup();
      await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({ label: 'x'.repeat(121) })
        .expect(400);
      await prisma.documentVersion.createMany({
        data: Array.from({ length: MAX_VERSIONS }, () => ({
          documentId,
          state: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())),
          kind: 'MANUAL' as const,
          title: 'Plan',
        })),
      });
      const response = await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({})
        .expect(409);
      expect(response.body.code).toBe('CONFLICT');
    });
  });

  describe('reading versions', () => {
    it('lists newest first with the kind, label, title and author', async () => {
      const { owner, documentId } = await setup();
      await writeContent(documentId, 'x');
      await versions.create({ documentId, kind: 'AUTO' });
      await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({ label: 'named' })
        .expect(201);
      await versions.create({ documentId, kind: 'PRE_RESTORE', createdBy: owner.id });

      const list = await as(owner).get(`/documents/${documentId}/versions`).expect(200);
      expect(list.body.map((v: { kind: string }) => v.kind)).toEqual([
        'PRE_RESTORE',
        'MANUAL',
        'AUTO',
      ]);
      expect(list.body[2]).toMatchObject({ author: null, label: null });
      expect(list.body[1]).toMatchObject({ label: 'named', author: { id: owner.id } });
      expect(list.body[0]).not.toHaveProperty('state');
    });

    it('never returns markup that is not part of the content model', async () => {
      const { owner, documentId } = await setup();
      await writeContent(documentId, 'text', (doc) => {
        const script = new Y.XmlElement('script');
        script.insert(0, [new Y.XmlText('alert(1)')]);
        script.setAttribute('src', 'https://evil.example/x.js');
        doc.getXmlFragment('content').insert(1, [script]);
      });
      const created = await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({})
        .expect(201);
      const detail = await as(owner)
        .get(`/documents/${documentId}/versions/${created.body.id}`)
        .expect(200);
      expect(JSON.stringify(detail.body.content)).not.toContain('script');
      expect(JSON.stringify(detail.body.content)).not.toContain('evil.example');
    });

    it('answers 404 for an unknown version and for a version of another document', async () => {
      const a = await setup();
      const b = await setup();
      const created = await as(b.owner)
        .post(`/documents/${b.documentId}/versions`)
        .send({})
        .expect(201);
      await as(a.owner).get(`/documents/${a.documentId}/versions/${UNKNOWN_ID}`).expect(404);
      await as(a.owner).get(`/documents/${a.documentId}/versions/${created.body.id}`).expect(404);
      await as(a.owner).get(`/documents/${a.documentId}/versions/not-a-uuid`).expect(400);
    });
  });

  describe('restoring', () => {
    it('hands the restore to collab, which does the work, and returns the new revision', async () => {
      const { owner, documentId } = await setup();
      const created = await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({})
        .expect(201);
      calls.length = 0;
      collabBody = { revision: 7 };
      const response = await as(owner)
        .post(`/documents/${documentId}/versions/${created.body.id}/restore`)
        .expect(200);
      expect(response.body).toEqual({ revision: 7 });
      expect(calls).toEqual([
        {
          path: `/internal/documents/${documentId}/restore`,
          authorization: `Bearer ${parseConfig(process.env).INTERNAL_API_TOKEN}`,
          body: { versionId: created.body.id, userId: owner.id },
        },
      ]);
    });

    it('does not bother collab about a version that is not the document’s', async () => {
      const a = await setup();
      const b = await setup();
      const created = await as(b.owner)
        .post(`/documents/${b.documentId}/versions`)
        .send({})
        .expect(201);
      calls.length = 0;
      await as(a.owner)
        .post(`/documents/${a.documentId}/versions/${created.body.id}/restore`)
        .expect(404);
      expect(calls).toHaveLength(0);
    });

    it('answers 503 when collab is down or fails, so a restore never looks successful by accident', async () => {
      const { owner, documentId } = await setup();
      const created = await as(owner)
        .post(`/documents/${documentId}/versions`)
        .send({})
        .expect(201);
      const url = `/documents/${documentId}/versions/${created.body.id}/restore`;

      collabStatus = 500;
      expect((await as(owner).post(url).expect(503)).body.code).toBe('SERVICE_UNAVAILABLE');
      collabStatus = 200;
      app.get(ConfigService).set('COLLAB_INTERNAL_URL', 'http://127.0.0.1:1');
      expect((await as(owner).post(url).expect(503)).body.code).toBe('SERVICE_UNAVAILABLE');
    });
  });

  describe('retention job', () => {
    it('registers one hourly schedule however often the worker starts, and prunes when it runs', async () => {
      const { documentId } = await setup();
      const queues = app.get(QueueService, { strict: false });
      for (let i = 0; i < 55; i += 1) await versions.create({ documentId, kind: 'AUTO' });

      // the worker module already registered the schedule on start; starting again must not stack another
      const processor = app.get(VersionPruneProcessor, { strict: false });
      await processor.onModuleInit();
      await processor.onModuleInit();
      const schedulers = await queues.getQueue(QUEUE_NAMES.versionPrune).getJobSchedulers();
      expect(schedulers.filter((s) => s.key === 'version-prune-hourly')).toHaveLength(1);

      await queues.getQueue(QUEUE_NAMES.versionPrune).add('prune', {});
      const deadline = Date.now() + 8000;
      let remaining = 55;
      while (Date.now() < deadline) {
        remaining = await prisma.documentVersion.count({ where: { documentId, kind: 'AUTO' } });
        if (remaining === 50) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(remaining).toBe(50);
    });
  });
});
