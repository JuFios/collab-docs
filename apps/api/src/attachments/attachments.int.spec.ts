import '../test/attachments-env';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { PrismaClient } from '@collab-docs/db';
import { PLAN_CATALOG } from '@collab-docs/shared';
import { createTestApp } from '../test/test-app';
import { S3Storage } from '../storage';
import { AttachmentSweeper } from './attachment-sweeper';

const PASSWORD = 'correct-horse-battery';
const UNKNOWN_ID = '0198d6c0-0000-7000-8000-000000000000';
const MB = 1024 * 1024;

// a valid 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.alloc(32)]);

interface TestUser {
  id: string;
  token: string;
}

interface Presigned {
  attachmentId: string;
  url: string;
  fields: Record<string, string>;
}

describe('attachments', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let s3: S3Storage;
  let sweeper: AttachmentSweeper;
  let redis: Redis;
  let counter = 0;

  const http$ = () => request(app.getHttpServer());

  async function register(label: string): Promise<TestUser> {
    const email = `${label}-${Date.now()}-${counter++}@attachments-test.example`;
    const response = await http$()
      .post('/api/auth/register')
      .set('X-Forwarded-For', `10.7.${counter % 250}.${(counter * 7) % 250}`)
      .send({ email, password: PASSWORD, name: label })
      .expect(201);
    return { id: response.body.user.id, token: response.body.accessToken };
  }

  const as = (user: TestUser) => {
    const auth = <T extends request.Test>(req: T): T =>
      req.set('Authorization', `Bearer ${user.token}`) as T;
    return {
      get: (path: string) => auth(http$().get(`/api${path}`)),
      post: (path: string) => auth(http$().post(`/api${path}`)),
      delete: (path: string) => auth(http$().delete(`/api${path}`)),
    };
  };

  async function setup() {
    const [owner, editor, viewer, outsider] = await Promise.all(
      ['owner', 'editor', 'viewer', 'outsider'].map(register),
    );
    const workspace = await as(owner!).post('/workspaces').send({ name: 'Media' }).expect(201);
    const workspaceId = workspace.body.id as string;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: editor!.id, role: 'EDITOR' },
        { workspaceId, userId: viewer!.id, role: 'VIEWER' },
      ],
    });
    const created = await as(owner!)
      .post(`/workspaces/${workspaceId}/documents`)
      .send({ title: 'Gallery' })
      .expect(201);
    return {
      owner: owner!,
      editor: editor!,
      viewer: viewer!,
      outsider: outsider!,
      workspaceId,
      documentId: created.body.id as string,
    };
  }

  const presign = (
    user: TestUser,
    documentId: string,
    body: { filename?: string; mime?: string; size?: number } = {},
  ) =>
    as(user)
      .post(`/documents/${documentId}/attachments/presign`)
      .send({ filename: 'a.png', mime: 'image/png', size: PNG.length, ...body });

  /** What the browser does: the policy fields first, the file last. */
  async function upload(
    presigned: Presigned,
    body: Buffer,
    overrides: Record<string, string> = {},
  ): Promise<Response> {
    const form = new FormData();
    for (const [name, value] of Object.entries({ ...presigned.fields, ...overrides })) {
      form.append(name, value);
    }
    form.append('file', new Blob([new Uint8Array(body)]), 'upload.bin');
    return fetch(presigned.url, { method: 'POST', body: form });
  }

  /** presign + upload + complete for a PNG. */
  async function uploadedPng(user: TestUser, documentId: string): Promise<string> {
    const presigned = (await presign(user, documentId).expect(201)).body as Presigned;
    expect((await upload(presigned, PNG)).status).toBe(204);
    await as(user).post(`/attachments/${presigned.attachmentId}/complete`).expect(200);
    return presigned.attachmentId;
  }

  /** Fills the workspace quota with ready rows so that exactly `free` bytes remain. */
  async function fillQuota(workspaceId: string, documentId: string, userId: string, free: number) {
    const used = PLAN_CATALOG.FREE.maxStorageBytes - free;
    await prisma.attachment.create({
      data: {
        workspaceId,
        documentId,
        key: `ws/${workspaceId}/doc/${documentId}/filler-${counter++}`,
        size: used,
        mime: 'image/png',
        status: 'READY',
        uploadedBy: userId,
      },
    });
  }

  beforeAll(async () => {
    const flush = new Redis(process.env.REDIS_URL as string);
    await flush.flushdb();
    flush.disconnect();
    redis = new Redis(process.env.REDIS_URL as string);
    app = await createTestApp();
    prisma = app.get(PrismaClient, { strict: false });
    s3 = app.get(S3Storage, { strict: false });
    sweeper = app.get(AttachmentSweeper, { strict: false });
  });

  afterAll(async () => {
    redis.disconnect();
    await app.close();
  });

  describe('upload flow', () => {
    it('presigns, uploads straight to storage, completes and serves a short-lived URL', async () => {
      const { editor, owner, workspaceId, documentId } = await setup();
      const presigned = (await presign(editor, documentId).expect(201)).body as Presigned;

      expect(presigned.url).toContain('localhost:9000');
      expect(presigned.fields['Content-Type']).toBe('image/png');
      const row = await prisma.attachment.findUniqueOrThrow({
        where: { id: presigned.attachmentId },
      });
      expect(row).toMatchObject({
        workspaceId,
        documentId,
        status: 'PENDING',
        mime: 'image/png',
        size: PNG.length,
        uploadedBy: editor.id,
      });
      expect(row.key).toMatch(new RegExp(`^ws/${workspaceId}/doc/${documentId}/[0-9a-f-]{36}$`));

      expect((await upload(presigned, PNG)).status).toBe(204);
      const done = await as(editor)
        .post(`/attachments/${presigned.attachmentId}/complete`)
        .expect(200);
      expect(done.body).toMatchObject({
        id: presigned.attachmentId,
        documentId,
        status: 'READY',
        size: PNG.length,
      });

      const read = await as(owner).get(`/attachments/${presigned.attachmentId}/url`).expect(200);
      expect(Date.parse(read.body.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
      const file = await fetch(read.body.url);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    });

    it('accepts a jpeg and treats a second complete as a no-op', async () => {
      const { owner, documentId } = await setup();
      const presigned = (
        await presign(owner, documentId, {
          filename: 'photo.JPG',
          mime: 'image/jpeg',
          size: JPEG.length,
        }).expect(201)
      ).body as Presigned;
      expect((await upload(presigned, JPEG)).status).toBe(204);
      await as(owner).post(`/attachments/${presigned.attachmentId}/complete`).expect(200);
      const again = await as(owner)
        .post(`/attachments/${presigned.attachmentId}/complete`)
        .expect(200);
      expect(again.body.status).toBe('READY');
    });

    it('does not hand out a read URL before the upload is completed', async () => {
      const { owner, documentId } = await setup();
      const presigned = (await presign(owner, documentId).expect(201)).body as Presigned;
      await as(owner).get(`/attachments/${presigned.attachmentId}/url`).expect(404);
    });

    it('asks the client to upload first when the object is missing, and keeps the reservation', async () => {
      const { owner, documentId } = await setup();
      const presigned = (await presign(owner, documentId).expect(201)).body as Presigned;
      const response = await as(owner)
        .post(`/attachments/${presigned.attachmentId}/complete`)
        .expect(422);
      expect(response.body.details).toEqual({ reason: 'not_uploaded' });
      expect(await prisma.attachment.count({ where: { id: presigned.attachmentId } })).toBe(1);
    });
  });

  describe('validation at every layer', () => {
    it('refuses SVG and other types at presign', async () => {
      const { owner, documentId } = await setup();
      await presign(owner, documentId, { filename: 'a.svg', mime: 'image/svg+xml' }).expect(400);
      await presign(owner, documentId, { filename: 'a.txt', mime: 'text/plain' }).expect(400);
      await presign(owner, documentId, { filename: 'a.html', mime: 'text/html' }).expect(400);
    });

    it('refuses a file name whose extension does not belong to the declared type', async () => {
      const { owner, documentId } = await setup();
      const svg = await presign(owner, documentId, { filename: 'a.svg', mime: 'image/png' }).expect(
        400,
      );
      expect(svg.body.code).toBe('VALIDATION_FAILED');
      await presign(owner, documentId, { filename: 'noextension', mime: 'image/png' }).expect(400);
      await presign(owner, documentId, { filename: 'a.png', mime: 'image/jpeg' }).expect(400);
    });

    it('refuses empty and over-limit sizes without reserving anything', async () => {
      const { owner, workspaceId, documentId } = await setup();
      await presign(owner, documentId, { size: 0 }).expect(400);
      await presign(owner, documentId, { size: 1.5 }).expect(400);
      const tooBig = await presign(owner, documentId, { size: 10 * MB + 1 }).expect(413);
      expect(tooBig.body.code).toBe('PAYLOAD_TOO_LARGE');
      expect(await prisma.attachment.count({ where: { workspaceId } })).toBe(0);
    });

    it('lets the bucket policy reject a file that is larger or smaller than declared', async () => {
      const { owner, documentId } = await setup();
      const presigned = (await presign(owner, documentId).expect(201)).body as Presigned;
      const larger = await upload(presigned, Buffer.concat([PNG, Buffer.alloc(64)]));
      expect(larger.status).toBe(400);
      expect(await larger.text()).toContain('EntityTooLarge');
      const smaller = await upload(presigned, PNG.subarray(0, PNG.length - 1));
      expect(smaller.status).toBe(400);
      expect(await smaller.text()).toContain('EntityTooSmall');
      expect(
        await s3.head(
          (await prisma.attachment.findUniqueOrThrow({ where: { id: presigned.attachmentId } }))
            .key,
        ),
      ).toBeNull();
    });

    it('lets the bucket policy reject another content type or key', async () => {
      const { owner, documentId } = await setup();
      const presigned = (await presign(owner, documentId).expect(201)).body as Presigned;
      const html = await upload(presigned, PNG, { 'Content-Type': 'text/html' });
      expect(html.status).toBe(403);
      const other = await upload(presigned, PNG, { key: `${presigned.fields.key}-other` });
      expect(other.status).toBe(403);
    });

    it('rejects text uploaded as a png (sniffed from the stored bytes), deletes it and frees the quota', async () => {
      const { owner, documentId } = await setup();
      const text = Buffer.from('this is definitely not an image');
      const presigned = (
        await presign(owner, documentId, { filename: 'fake.png', size: text.length }).expect(201)
      ).body as Presigned;
      const key = (
        await prisma.attachment.findUniqueOrThrow({ where: { id: presigned.attachmentId } })
      ).key;
      expect((await upload(presigned, text)).status).toBe(204);
      expect(await s3.head(key)).not.toBeNull();

      const response = await as(owner)
        .post(`/attachments/${presigned.attachmentId}/complete`)
        .expect(422);
      expect(response.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'content_mismatch' },
      });
      expect(await s3.head(key)).toBeNull();
      expect(await prisma.attachment.count({ where: { id: presigned.attachmentId } })).toBe(0);
    });

    it('rejects an svg that was uploaded under an image content type', async () => {
      const { owner, documentId } = await setup();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
      const presigned = (await presign(owner, documentId, { size: svg.length }).expect(201))
        .body as Presigned;
      expect((await upload(presigned, svg)).status).toBe(204);
      const response = await as(owner)
        .post(`/attachments/${presigned.attachmentId}/complete`)
        .expect(422);
      expect(response.body.details.reason).toBe('content_mismatch');
    });

    it('rejects a jpeg declared as a png', async () => {
      const { owner, documentId } = await setup();
      const presigned = (await presign(owner, documentId, { size: JPEG.length }).expect(201))
        .body as Presigned;
      expect((await upload(presigned, JPEG)).status).toBe(204);
      await as(owner).post(`/attachments/${presigned.attachmentId}/complete`).expect(422);
    });
  });

  describe('quota', () => {
    it('allows an upload that exactly fills the plan and refuses one byte more', async () => {
      const { owner, workspaceId, documentId } = await setup();
      await fillQuota(workspaceId, documentId, owner.id, 100);
      const refused = await presign(owner, documentId, { size: 101 }).expect(403);
      expect(refused.body).toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: {
          kind: 'storage',
          limit: PLAN_CATALOG.FREE.maxStorageBytes,
          current: PLAN_CATALOG.FREE.maxStorageBytes - 100,
          plan: 'FREE',
        },
      });
      await presign(owner, documentId, { size: 100 }).expect(201);
      await presign(owner, documentId, { size: 1 }).expect(403);
    });

    it('counts uploads that are still pending', async () => {
      const { owner, workspaceId, documentId } = await setup();
      await fillQuota(workspaceId, documentId, owner.id, 10 * MB);
      await presign(owner, documentId, { size: 10 * MB }).expect(201);
      await presign(owner, documentId, { size: 1 }).expect(403);
    });

    it('serialises two parallel presigns so that only one fits', async () => {
      const { owner, editor, workspaceId, documentId } = await setup();
      await fillQuota(workspaceId, documentId, owner.id, 15 * MB);
      const statuses = (
        await Promise.all([
          presign(owner, documentId, { size: 10 * MB }),
          presign(editor, documentId, { size: 10 * MB }),
        ])
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([201, 403]);
      expect(await prisma.attachment.count({ where: { workspaceId, status: 'PENDING' } })).toBe(1);
    });

    it('reports the stored bytes in the workspace usage', async () => {
      const { owner, workspaceId, documentId } = await setup();
      await uploadedPng(owner, documentId);
      await presign(owner, documentId, { size: 500 }).expect(201);
      const usage = await as(owner).get(`/workspaces/${workspaceId}/usage`).expect(200);
      expect(usage.body.storage).toEqual({
        currentBytes: PNG.length + 500,
        limitBytes: PLAN_CATALOG.FREE.maxStorageBytes,
      });
    });

    it('uses the limit of the upgraded plan', async () => {
      const { owner, workspaceId, documentId } = await setup();
      await fillQuota(workspaceId, documentId, owner.id, 0);
      await presign(owner, documentId).expect(403);
      await prisma.subscription.upsert({
        where: { workspaceId },
        create: { workspaceId, plan: 'PRO' },
        update: { plan: 'PRO' },
      });
      await presign(owner, documentId).expect(201);
    });
  });

  describe('permissions', () => {
    it('lets a viewer read but not presign or complete; an outsider sees nothing', async () => {
      const { owner, viewer, outsider, documentId } = await setup();
      const attachmentId = await uploadedPng(owner, documentId);

      await presign(viewer, documentId).expect(403);
      await as(viewer).post(`/attachments/${attachmentId}/complete`).expect(403);
      await as(viewer).get(`/attachments/${attachmentId}/url`).expect(200);

      await presign(outsider, documentId).expect(404);
      await as(outsider).post(`/attachments/${attachmentId}/complete`).expect(404);
      await as(outsider).get(`/attachments/${attachmentId}/url`).expect(404);
    });

    it('answers 404 for unknown and malformed attachment ids', async () => {
      const { owner } = await setup();
      await as(owner).get(`/attachments/${UNKNOWN_ID}/url`).expect(404);
      await as(owner).post(`/attachments/${UNKNOWN_ID}/complete`).expect(404);
      await as(owner).get('/attachments/not-a-uuid/url').expect(400);
    });

    it("keeps another workspace's attachment hidden even from an editor elsewhere", async () => {
      const first = await setup();
      const second = await setup();
      const attachmentId = await uploadedPng(first.owner, first.documentId);
      await as(second.owner).get(`/attachments/${attachmentId}/url`).expect(404);
      await as(second.owner).post(`/attachments/${attachmentId}/complete`).expect(404);
      await presign(second.owner, first.documentId).expect(404);
    });

    it('follows a revoked role immediately', async () => {
      const { owner, editor, workspaceId, documentId } = await setup();
      const attachmentId = await uploadedPng(owner, documentId);
      await prisma.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId: editor.id } },
      });
      await as(editor).get(`/attachments/${attachmentId}/url`).expect(404);
      await presign(editor, documentId).expect(404);
    });

    it('requires authentication', async () => {
      const { documentId } = await setup();
      await http$()
        .post(`/api/documents/${documentId}/attachments/presign`)
        .send({ filename: 'a.png', mime: 'image/png', size: 1 })
        .expect(401);
      await http$().get(`/api/attachments/${UNKNOWN_ID}/url`).expect(401);
    });

    it('keeps attachments when their document is deleted, but stops serving them', async () => {
      const { owner, documentId } = await setup();
      const attachmentId = await uploadedPng(owner, documentId);
      // soft-deleted straight in the database: the API would publish `doc.deleted`, and Redis pub/sub is not
      // scoped to a database, so a parallel suite that listens for that channel would see this event
      await prisma.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } });
      expect(await prisma.attachment.count({ where: { id: attachmentId } })).toBe(1);
      await as(owner).get(`/attachments/${attachmentId}/url`).expect(404);
      await presign(owner, documentId).expect(404);
    });
  });

  describe('abandoned uploads', () => {
    it('sweeps stale pending uploads with their objects and leaves everything else alone', async () => {
      const { owner, workspaceId, documentId } = await setup();
      const ready = await uploadedPng(owner, documentId);

      const stale = (await presign(owner, documentId).expect(201)).body as Presigned;
      expect((await upload(stale, PNG)).status).toBe(204);
      const fresh = (await presign(owner, documentId).expect(201)).body as Presigned;
      const staleRow = await prisma.attachment.findUniqueOrThrow({
        where: { id: stale.attachmentId },
      });
      await prisma.attachment.update({
        where: { id: stale.attachmentId },
        data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
      });
      // a completed upload is never swept, however old
      await prisma.attachment.update({
        where: { id: ready },
        data: { createdAt: new Date(Date.now() - 48 * 3_600_000) },
      });

      expect(await sweeper.sweep()).toBeGreaterThanOrEqual(1);
      expect(await prisma.attachment.count({ where: { id: stale.attachmentId } })).toBe(0);
      expect(await s3.head(staleRow.key)).toBeNull();
      expect(
        await prisma.attachment.count({ where: { id: { in: [ready, fresh.attachmentId] } } }),
      ).toBe(2);

      const usage = await as(owner).get(`/workspaces/${workspaceId}/usage`).expect(200);
      expect(usage.body.storage.currentBytes).toBe(PNG.length + PNG.length);
    });

    it('fails a completion that loses against the sweep instead of leaving a ready row without a file', async () => {
      const { owner, documentId } = await setup();
      const presigned = (await presign(owner, documentId).expect(201)).body as Presigned;
      expect((await upload(presigned, PNG)).status).toBe(204);
      await prisma.attachment.update({
        where: { id: presigned.attachmentId },
        data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
      });
      await sweeper.sweep();
      await as(owner).post(`/attachments/${presigned.attachmentId}/complete`).expect(404);
    });
  });
});
