import '../test/collab-env';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { PrismaClient } from '@collab-docs/db';
import { currentConfig, verifyCollabTicket } from '@collab-docs/shared/nest';
import { createTestApp } from '../test/test-app';

const PASSWORD = 'correct-horse-battery';

interface TestUser {
  id: string;
  token: string;
  email: string;
}

describe('collab ticket', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let redis: Redis;
  let counter = 0;

  const http$ = () => request(app.getHttpServer());

  async function register(label: string): Promise<TestUser> {
    const email = `${label}-${Date.now()}-${counter++}@ticket-test.example`;
    const response = await http$()
      .post('/api/auth/register')
      .set('X-Forwarded-For', `10.7.${counter % 250}.${(counter * 7) % 250}`)
      .send({ email, password: PASSWORD, name: label })
      .expect(201);
    return { id: response.body.user.id, email, token: response.body.accessToken };
  }

  const post = (user: TestUser | null, path: string) => {
    const req = http$().post(`/api${path}`);
    return user ? req.set('Authorization', `Bearer ${user.token}`) : req;
  };

  async function setup() {
    const [owner, viewer, outsider] = await Promise.all(
      ['owner', 'viewer', 'outsider'].map(register),
    );
    const workspace = await post(owner!, '/workspaces').send({ name: 'Docs' }).expect(201);
    const workspaceId = workspace.body.id as string;
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: viewer!.id, role: 'VIEWER' },
    });
    const document = await post(owner!, `/workspaces/${workspaceId}/documents`)
      .send({ title: 'Doc' })
      .expect(201);
    return {
      owner: owner!,
      viewer: viewer!,
      outsider: outsider!,
      documentId: document.body.id as string,
    };
  }

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL as string);
    await redis.flushdb();
    app = await createTestApp();
    prisma = app.get(PrismaClient, { strict: false });
  });

  afterAll(async () => {
    await app.close();
    redis.disconnect();
  });

  it('issues a signed 60 s ticket and the ws url to anyone with VIEW', async () => {
    const { owner, viewer, documentId } = await setup();
    for (const user of [owner, viewer]) {
      const response = await post(user, `/documents/${documentId}/collab-ticket`).expect(200);
      expect(response.body.wsUrl).toBe('ws://localhost:4001/ws');
      const claims = await verifyCollabTicket(
        currentConfig().COLLAB_TICKET_SECRET,
        response.body.ticket,
      );
      expect(claims).toMatchObject({ docId: documentId, sub: user.id });
      expect(claims.correlationId).toEqual(expect.any(String));
    }
  });

  it('answers 404 to a user without access and 401 to anonymous callers', async () => {
    const { outsider, documentId } = await setup();
    await post(outsider, `/documents/${documentId}/collab-ticket`).expect(404);
    await post(null, `/documents/${documentId}/collab-ticket`).expect(401);
    await post(outsider, '/documents/0198d6c0-0000-7000-8000-000000000000/collab-ticket').expect(
      404,
    );
  });

  it('answers 404 once the document is deleted', async () => {
    const { owner, documentId } = await setup();
    await post(owner, `/documents/${documentId}/collab-ticket`).expect(200);
    await http$()
      .delete(`/api/documents/${documentId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);
    await post(owner, `/documents/${documentId}/collab-ticket`).expect(404);
  });

  it('limits tickets per user', async () => {
    const { owner, viewer, documentId } = await setup();
    const limit = currentConfig().RATE_TICKET_PER_MIN_USER;
    for (let i = 0; i < limit; i += 1) {
      await post(owner, `/documents/${documentId}/collab-ticket`).expect(200);
    }
    const blocked = await post(owner, `/documents/${documentId}/collab-ticket`).expect(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // another user is not affected
    await post(viewer, `/documents/${documentId}/collab-ticket`).expect(200);
  });
});
