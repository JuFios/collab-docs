import '../test/env/billing';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import type { PrismaClient } from '@collab-docs/db';
import {
  BILLING_EVENT_TYPES,
  MOCK_SIGNATURE_HEADER,
  PLAN_CATALOG,
  type PlanTier,
  type WorkspaceRole,
} from '@collab-docs/shared';
import { AppException, QueueService } from '@collab-docs/nest';
import { createTestApp } from '../test/test-app';
import { PrismaService } from '../prisma/prisma.service';
import { BillingEventsService } from './billing-events.service';
import { BillingWorkerModule } from './billing.module';
import { WebhookService } from './webhook.service';
import { signWebhook } from './webhook-signature';

const PASSWORD = 'correct-horse-battery';
const SECRET = 'dev-only-webhook-signing-secret-change-me';
const UNKNOWN_ID = '0198d6c0-0000-7000-8000-000000000000';

interface TestUser {
  id: string;
  token: string;
  email: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting, last value: ${JSON.stringify(value)}`);
    await wait(40);
  }
}

describe('billing', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let counter = 0;

  const http$ = () => request(app.getHttpServer());

  async function register(label: string): Promise<TestUser> {
    const email = `${label}-${Date.now()}-${counter++}@billing-test.example`;
    const response = await http$()
      .post('/api/auth/register')
      .set('X-Forwarded-For', `10.3.${counter % 250}.${(counter * 7) % 250}`)
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
    const owner = await register('owner');
    const created = await as(owner).post('/workspaces').send({ name: 'Acme' }).expect(201);
    return { owner, workspaceId: created.body.id as string };
  }

  async function addMember(workspaceId: string, role: WorkspaceRole): Promise<TestUser> {
    const user = await register(role.toLowerCase());
    await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
    return user;
  }

  const planOf = async (workspaceId: string): Promise<PlanTier> =>
    (await prisma.subscription.findUniqueOrThrow({ where: { workspaceId } })).plan;

  const invoiceCount = (workspaceId: string) => prisma.invoice.count({ where: { workspaceId } });

  const checkout = async (user: TestUser, workspaceId: string, plan: 'PRO' | 'TEAM') => {
    const response = await as(user)
      .post(`/workspaces/${workspaceId}/billing/checkout`)
      .send({ plan })
      .expect(201);
    return response.body as { sessionId: string; checkoutUrl: string };
  };

  const provider = (path: string) => http$().post(`/api/mock-provider${path}`);

  /** Checkout, pay, and wait until the webhook has been applied. */
  async function upgrade(user: TestUser, workspaceId: string, plan: 'PRO' | 'TEAM') {
    const { sessionId } = await checkout(user, workspaceId, plan);
    const paid = await provider(`/checkout-sessions/${sessionId}/complete`).expect(202);
    await until(
      () => planOf(workspaceId),
      (current) => current === plan,
    );
    return { sessionId, eventId: paid.body.eventId as string };
  }

  /** A provider event, signed as the provider would, sent straight to the webhook. */
  function signedEvent(type: string, data: object, created = Date.now()) {
    const id = `evt_${randomBytes(16).toString('hex')}`;
    const text = JSON.stringify({ id, type, created, data });
    return { id, text };
  }

  const post = (text: string, signature: string | undefined = signWebhook(SECRET, text)) => {
    const req = http$().post('/api/billing/webhooks/mock').set('Content-Type', 'application/json');
    return (signature ? req.set(MOCK_SIGNATURE_HEADER, signature) : req).send(text);
  };

  const eventStatus = async (eventId: string) =>
    (await prisma.webhookEvent.findUnique({ where: { eventId } }))?.status ?? null;

  const processed = (eventId: string) =>
    until(
      () => eventStatus(eventId),
      (status) => status === 'PROCESSED',
    );

  async function duplicateDeliveries(): Promise<number> {
    const metrics = await http$()
      .get('/metrics')
      .set('Authorization', `Bearer ${process.env.METRICS_TOKEN}`)
      .expect(200);
    const line = (metrics.text as string)
      .split('\n')
      .find((l) => l.startsWith('billing_webhook_deliveries_total{result="duplicate"}'));
    return line ? Number(line.split(' ')[1]) : 0;
  }

  beforeAll(async () => {
    const flush = new Redis(process.env.REDIS_URL as string);
    await flush.flushdb();
    flush.disconnect();

    app = await createTestApp([], [BillingWorkerModule]);
    // the delivery processor posts to the webhook over HTTP, so the app has to listen
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as { port: number };
    app.get(ConfigService).set('API_INTERNAL_URL', `http://127.0.0.1:${port}`);
    prisma = app.get(PrismaService, { strict: false });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('plans', () => {
    it('lists the plans with prices and limits', async () => {
      const { owner } = await setup();
      const response = await as(owner).get('/billing/plans').expect(200);
      expect(response.body).toEqual([
        {
          plan: 'FREE',
          priceCents: 0,
          maxMembers: 3,
          maxDocuments: 20,
          maxStorageBytes: PLAN_CATALOG.FREE.maxStorageBytes,
        },
        {
          plan: 'PRO',
          priceCents: 1200,
          maxMembers: 10,
          maxDocuments: 500,
          maxStorageBytes: PLAN_CATALOG.PRO.maxStorageBytes,
        },
        {
          plan: 'TEAM',
          priceCents: 4900,
          maxMembers: 50,
          maxDocuments: null,
          maxStorageBytes: PLAN_CATALOG.TEAM.maxStorageBytes,
        },
      ]);
    });

    it('requires a signed-in user', async () => {
      await as(null).get('/billing/plans').expect(401);
    });
  });

  describe('who may manage billing', () => {
    it('lets owners and admins in, keeps editors, viewers and outsiders out', async () => {
      const { owner, workspaceId } = await setup();
      const admin = await addMember(workspaceId, 'ADMIN');
      const editor = await addMember(workspaceId, 'EDITOR');
      const viewer = await addMember(workspaceId, 'VIEWER');
      const outsider = await register('outsider');

      for (const user of [owner, admin]) {
        await as(user).get(`/workspaces/${workspaceId}/billing`).expect(200);
      }
      for (const user of [editor, viewer]) {
        await as(user).get(`/workspaces/${workspaceId}/billing`).expect(403);
        await as(user)
          .post(`/workspaces/${workspaceId}/billing/checkout`)
          .send({ plan: 'PRO' })
          .expect(403);
        await as(user).post(`/workspaces/${workspaceId}/billing/cancel`).expect(403);
      }
      await as(outsider).get(`/workspaces/${workspaceId}/billing`).expect(404);
      await as(outsider)
        .post(`/workspaces/${workspaceId}/billing/checkout`)
        .send({ plan: 'PRO' })
        .expect(404);
      expect(await prisma.checkoutSession.count({ where: { workspaceId } })).toBe(0);
    });

    it('lets an admin start a checkout', async () => {
      const { workspaceId } = await setup();
      const admin = await addMember(workspaceId, 'ADMIN');
      await checkout(admin, workspaceId, 'TEAM');
    });
  });

  describe('checkout', () => {
    it('creates a pending session at the price of the plan and points at the payment page', async () => {
      const { owner, workspaceId } = await setup();
      const started = await checkout(owner, workspaceId, 'PRO');

      expect(started.checkoutUrl).toBe(`/mock-checkout/${started.sessionId}`);
      expect(
        await prisma.checkoutSession.findUniqueOrThrow({ where: { id: started.sessionId } }),
      ).toMatchObject({ workspaceId, plan: 'PRO', amountCents: 1200, status: 'PENDING' });
      // nothing changes until the provider confirms
      expect(await planOf(workspaceId)).toBe('FREE');
    });

    it.each(['FREE', 'ENTERPRISE', '', undefined])('refuses the plan %j', async (plan) => {
      const { owner, workspaceId } = await setup();
      const response = await as(owner)
        .post(`/workspaces/${workspaceId}/billing/checkout`)
        .send({ plan })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a checkout for the plan the workspace is already on', async () => {
      const { owner, workspaceId } = await setup();
      await upgrade(owner, workspaceId, 'PRO');
      const response = await as(owner)
        .post(`/workspaces/${workspaceId}/billing/checkout`)
        .send({ plan: 'PRO' })
        .expect(409);
      expect(response.body.code).toBe('CONFLICT');
    });
  });

  describe('paying', () => {
    it('checkout, payment, signed webhook: the plan changes, one invoice, the limits of the new plan apply', async () => {
      const { owner, workspaceId } = await setup();
      const invite = (email: string) =>
        as(owner).post(`/workspaces/${workspaceId}/invites`).send({ email, role: 'EDITOR' });

      // FREE: the owner and two invites fill the three seats
      await invite('a@billing-test.example').expect(201);
      await invite('b@billing-test.example').expect(201);
      const refused = await invite('c@billing-test.example').expect(403);
      expect(refused.body).toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: { kind: 'members', limit: 3, current: 3, plan: 'FREE' },
      });

      const { sessionId } = await upgrade(owner, workspaceId, 'PRO');

      await invite('c@billing-test.example').expect(201);
      const overview = await as(owner).get(`/workspaces/${workspaceId}/billing`).expect(200);
      expect(overview.body).toMatchObject({
        plan: 'PRO',
        status: 'ACTIVE',
        overLimit: [],
        invoices: [{ plan: 'PRO', amountCents: 1200 }],
      });
      expect(overview.body.currentPeriodEnd).toEqual(expect.any(String));
      expect(overview.body.usage).toEqual([
        { kind: 'members', current: 4, limit: 10 },
        { kind: 'documents', current: 0, limit: 500 },
        { kind: 'storage', current: 0, limit: PLAN_CATALOG.PRO.maxStorageBytes },
      ]);
      expect(
        await prisma.checkoutSession.findUniqueOrThrow({ where: { id: sessionId } }),
      ).toMatchObject({ status: 'COMPLETED' });
    });

    it('does not change the plan when the customer pays, only when the webhook is applied', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await checkout(owner, workspaceId, 'TEAM');
      // the provider issues the event, but its delivery never happens
      jest.spyOn(app.get(QueueService), 'add').mockResolvedValue({} as never);

      const paid = await provider(`/checkout-sessions/${sessionId}/complete`).expect(202);

      expect(await prisma.mockProviderEvent.count({ where: { id: paid.body.eventId } })).toBe(1);
      expect(await prisma.webhookEvent.count({ where: { eventId: paid.body.eventId } })).toBe(0);
      expect(await planOf(workspaceId)).toBe('FREE');
      expect(await invoiceCount(workspaceId)).toBe(0);
      expect(
        await prisma.checkoutSession.findUniqueOrThrow({ where: { id: sessionId } }),
      ).toMatchObject({ status: 'PENDING' });
    });

    it('a declined payment leaves the plan and the invoices alone', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await checkout(owner, workspaceId, 'PRO');

      const failed = await provider(`/checkout-sessions/${sessionId}/fail`).expect(202);
      await processed(failed.body.eventId);

      expect(
        await prisma.checkoutSession.findUniqueOrThrow({ where: { id: sessionId } }),
      ).toMatchObject({ status: 'FAILED' });
      expect(await planOf(workspaceId)).toBe('FREE');
      expect(await invoiceCount(workspaceId)).toBe(0);
    });

    it('issues one outcome when a session is paid and declined at the same time', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await checkout(owner, workspaceId, 'PRO');
      const answers = await Promise.all([
        provider(`/checkout-sessions/${sessionId}/complete`),
        provider(`/checkout-sessions/${sessionId}/fail`),
        provider(`/checkout-sessions/${sessionId}/complete`),
      ]);

      expect(answers.map((answer) => answer.status).sort()).toEqual([202, 409, 409]);
      expect(
        await prisma.mockProviderEvent.count({ where: { checkoutSessionId: sessionId } }),
      ).toBe(1);
    });

    it('settles a session once: paying it again is refused by the provider', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await upgrade(owner, workspaceId, 'PRO');

      const again = await provider(`/checkout-sessions/${sessionId}/complete`).expect(409);
      expect(again.body.code).toBe('CONFLICT');
      await provider(`/checkout-sessions/${sessionId}/fail`).expect(409);
      expect(await invoiceCount(workspaceId)).toBe(1);
    });

    it('delivers again after a failed attempt: at-least-once, with the queue retrying', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await checkout(owner, workspaceId, 'PRO');
      const receive = jest
        .spyOn(app.get(WebhookService), 'receive')
        .mockRejectedValueOnce(new AppException('SERVICE_UNAVAILABLE', 'try later'));

      await provider(`/checkout-sessions/${sessionId}/complete`).expect(202);

      await until(
        () => planOf(workspaceId),
        (plan) => plan === 'PRO',
      );
      expect(receive.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(await invoiceCount(workspaceId)).toBe(1);
    });
  });

  describe('idempotency', () => {
    it('a redelivered event changes neither the plan nor the invoices, and is counted as a duplicate', async () => {
      const { owner, workspaceId } = await setup();
      const { eventId } = await upgrade(owner, workspaceId, 'PRO');
      await processed(eventId);
      const before = await duplicateDeliveries();

      await provider(`/events/${eventId}/redeliver`).expect(202);
      await provider(`/events/${eventId}/redeliver`).expect(202);
      await until(duplicateDeliveries, (count) => count >= before + 2);

      expect(await planOf(workspaceId)).toBe('PRO');
      expect(await invoiceCount(workspaceId)).toBe(1);
      expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1);
    });

    it('answers a duplicate with 200 and { duplicate: true }', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await checkout(owner, workspaceId, 'PRO');
      const event = signedEvent(BILLING_EVENT_TYPES.checkoutCompleted, {
        checkoutSessionId: sessionId,
      });

      expect((await post(event.text).expect(200)).body).toEqual({ received: true });
      await processed(event.id);
      expect((await post(event.text).expect(200)).body).toEqual({ duplicate: true });

      expect(await invoiceCount(workspaceId)).toBe(1);
    });

    it('applies the event once when ten deliveries of it arrive at the same time', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await checkout(owner, workspaceId, 'PRO');
      const event = signedEvent(BILLING_EVENT_TYPES.checkoutCompleted, {
        checkoutSessionId: sessionId,
      });

      const responses = await Promise.all(Array.from({ length: 10 }, () => post(event.text)));
      expect(responses.map((response) => response.status)).toEqual(Array(10).fill(200));
      await processed(event.id);

      expect(await planOf(workspaceId)).toBe('PRO');
      expect(await invoiceCount(workspaceId)).toBe(1);
      expect(await prisma.webhookEvent.count({ where: { eventId: event.id } })).toBe(1);
    });

    it('applies the event once when ten workers process it at the same time', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await checkout(owner, workspaceId, 'TEAM');
      const event = signedEvent(BILLING_EVENT_TYPES.checkoutCompleted, {
        checkoutSessionId: sessionId,
      });
      await prisma.webhookEvent.create({
        data: {
          eventId: event.id,
          type: 'checkout.session.completed',
          payload: JSON.parse(event.text),
        },
      });
      const events = app.get(BillingEventsService);

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => events.process(event.id)),
      );

      expect(outcomes.filter((outcome) => outcome.result === 'applied')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.result === 'already_processed')).toHaveLength(9);
      expect(await planOf(workspaceId)).toBe('TEAM');
      expect(await invoiceCount(workspaceId)).toBe(1);
    });

    it('charges a session once when two different events complete it at the same time', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await checkout(owner, workspaceId, 'PRO');
      const first = signedEvent(BILLING_EVENT_TYPES.checkoutCompleted, {
        checkoutSessionId: sessionId,
      });
      const second = signedEvent(BILLING_EVENT_TYPES.checkoutCompleted, {
        checkoutSessionId: sessionId,
      });

      await Promise.all([post(first.text).expect(200), post(second.text).expect(200)]);
      await Promise.all([processed(first.id), processed(second.id)]);

      expect(await invoiceCount(workspaceId)).toBe(1);
      expect(await planOf(workspaceId)).toBe('PRO');
    });

    it('ignores the older of two events that arrive in the wrong order', async () => {
      const { owner, workspaceId } = await setup();
      const team = await checkout(owner, workspaceId, 'TEAM');
      const now = Date.now();
      const newer = signedEvent(
        BILLING_EVENT_TYPES.checkoutCompleted,
        { checkoutSessionId: team.sessionId },
        now,
      );
      // a cancellation issued before the upgrade, delivered after it
      const older = signedEvent(
        BILLING_EVENT_TYPES.subscriptionDeleted,
        { workspaceId },
        now - 5000,
      );

      await post(newer.text).expect(200);
      await processed(newer.id);
      await post(older.text).expect(200);
      await processed(older.id);

      expect(await planOf(workspaceId)).toBe('TEAM');
      expect(await invoiceCount(workspaceId)).toBe(1);
    });

    it('records a payment overtaken by a cancellation without bringing the plan back', async () => {
      const { owner, workspaceId } = await setup();
      await upgrade(owner, workspaceId, 'PRO');
      const team = await checkout(owner, workspaceId, 'TEAM');
      const now = Date.now();
      const paid = signedEvent(
        BILLING_EVENT_TYPES.checkoutCompleted,
        { checkoutSessionId: team.sessionId },
        now - 5000,
      );
      const canceled = signedEvent(BILLING_EVENT_TYPES.subscriptionDeleted, { workspaceId }, now);

      await post(canceled.text).expect(200);
      await processed(canceled.id);
      await post(paid.text).expect(200);
      await processed(paid.id);

      expect(await planOf(workspaceId)).toBe('FREE');
      expect(
        await prisma.checkoutSession.findUniqueOrThrow({ where: { id: team.sessionId } }),
      ).toMatchObject({ status: 'COMPLETED' });
      expect(await prisma.invoice.count({ where: { checkoutSessionId: team.sessionId } })).toBe(1);
      expect(await invoiceCount(workspaceId)).toBe(2);
    });

    it('cancels an open checkout when a new one starts, so only the newer one can be paid', async () => {
      const { owner, workspaceId } = await setup();
      const first = await checkout(owner, workspaceId, 'PRO');
      const second = await checkout(owner, workspaceId, 'PRO');

      expect(
        await prisma.checkoutSession.findUniqueOrThrow({ where: { id: first.sessionId } }),
      ).toMatchObject({ status: 'CANCELED', settledAt: expect.any(Date) });
      await provider(`/checkout-sessions/${first.sessionId}/complete`).expect(409);

      // the provider had collected it before the new checkout started; its event arrives only now. The money is
      // recorded, the plan is left alone
      const late = signedEvent(BILLING_EVENT_TYPES.checkoutCompleted, {
        checkoutSessionId: first.sessionId,
      });
      await post(late.text).expect(200);
      await processed(late.id);
      expect(await planOf(workspaceId)).toBe('FREE');
      expect(
        await prisma.checkoutSession.findUniqueOrThrow({ where: { id: first.sessionId } }),
      ).toMatchObject({ status: 'COMPLETED' });
      expect(await prisma.invoice.count({ where: { checkoutSessionId: first.sessionId } })).toBe(1);

      await provider(`/checkout-sessions/${second.sessionId}/complete`).expect(202);
      await until(
        () => planOf(workspaceId),
        (current) => current === 'PRO',
      );
      expect(await invoiceCount(workspaceId)).toBe(2);
    });

    it('recovers an event whose first delivery found the queue down', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await checkout(owner, workspaceId, 'PRO');
      const event = signedEvent(BILLING_EVENT_TYPES.checkoutCompleted, {
        checkoutSessionId: sessionId,
      });
      jest.spyOn(app.get(QueueService), 'add').mockRejectedValueOnce(new Error('redis is down'));

      const first = await post(event.text).expect(503);
      expect(first.body.code).toBe('SERVICE_UNAVAILABLE');
      // stored, not processed, and not a duplicate: the provider's next attempt has to queue it
      expect(await eventStatus(event.id)).toBe('RECEIVED');
      expect(await planOf(workspaceId)).toBe('FREE');

      expect((await post(event.text).expect(200)).body).toEqual({ received: true });
      await processed(event.id);
      expect(await planOf(workspaceId)).toBe('PRO');
      expect(await invoiceCount(workspaceId)).toBe(1);
    });
  });

  describe('signature', () => {
    const expectRejected = async (response: request.Test, eventId?: string) => {
      const result = await response.expect(401);
      expect(result.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      if (eventId) expect(await eventStatus(eventId)).toBeNull();
    };

    it('refuses a body signed with another secret', async () => {
      const event = signedEvent(BILLING_EVENT_TYPES.subscriptionDeleted, {
        workspaceId: UNKNOWN_ID,
      });
      await expectRejected(
        post(event.text, signWebhook('some-other-secret-0123456789', event.text)),
        event.id,
      );
    });

    it('refuses a body that was changed after signing', async () => {
      const event = signedEvent(BILLING_EVENT_TYPES.subscriptionDeleted, {
        workspaceId: UNKNOWN_ID,
      });
      const signature = signWebhook(SECRET, event.text);
      await expectRejected(
        post(event.text.replace('subscription', 'subscriptionX'), signature),
        event.id,
      );
    });

    it('refuses a correct signature that is older than five minutes', async () => {
      const event = signedEvent(BILLING_EVENT_TYPES.subscriptionDeleted, {
        workspaceId: UNKNOWN_ID,
      });
      const old = signWebhook(SECRET, event.text, Date.now() - 6 * 60 * 1000);
      await expectRejected(post(event.text, old), event.id);
    });

    it('refuses a delivery without the header, or with a malformed one', async () => {
      const event = signedEvent(BILLING_EVENT_TYPES.subscriptionDeleted, {
        workspaceId: UNKNOWN_ID,
      });
      const bare = http$()
        .post('/api/billing/webhooks/mock')
        .set('Content-Type', 'application/json')
        .send(event.text);
      await expectRejected(bare, event.id);
      await expectRejected(post(event.text, 'v1=deadbeef'), event.id);
    });

    it('refuses a body that is not JSON before it can be signed over', async () => {
      await http$()
        .post('/api/billing/webhooks/mock')
        .set('Content-Type', 'text/plain')
        .set(MOCK_SIGNATURE_HEADER, signWebhook(SECRET, 'plain'))
        .send('plain')
        .expect(401);
    });

    it('refuses a correctly signed body that is not a provider event', async () => {
      const text = JSON.stringify({ hello: 'world' });
      const response = await post(text).expect(400);
      expect(response.body.code).toBe('BAD_REQUEST');
    });

    it('acknowledges a signed event of a type it does not know and marks it processed', async () => {
      const event = signedEvent('invoice.paid', {});
      await post(event.text).expect(200);
      await processed(event.id);
    });
  });

  describe('mock provider', () => {
    it('shows the session to pay', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId } = await checkout(owner, workspaceId, 'TEAM');
      const response = await http$()
        .get(`/api/mock-provider/checkout-sessions/${sessionId}`)
        .expect(200);
      expect(response.body).toEqual({
        id: sessionId,
        workspaceId,
        plan: 'TEAM',
        amountCents: 4900,
        status: 'PENDING',
      });
    });

    it('answers 404 for a session or an event it does not know and 400 for a malformed id', async () => {
      await http$().get(`/api/mock-provider/checkout-sessions/${UNKNOWN_ID}`).expect(404);
      await provider(`/checkout-sessions/${UNKNOWN_ID}/complete`).expect(404);
      await provider('/checkout-sessions/not-a-uuid/complete').expect(400);
      await provider('/events/evt_unknown/redeliver').expect(404);
    });

    it('keeps the events it issued so that any of them can be sent again', async () => {
      const { owner, workspaceId } = await setup();
      const { sessionId, eventId } = await upgrade(owner, workspaceId, 'PRO');
      const stored = await prisma.mockProviderEvent.findUniqueOrThrow({ where: { id: eventId } });
      expect(stored).toMatchObject({
        type: 'checkout.session.completed',
        checkoutSessionId: sessionId,
      });
      expect(stored.payload).toMatchObject({ id: eventId, data: { checkoutSessionId: sessionId } });
    });
  });

  describe('cancelling', () => {
    it('returns the workspace to FREE once the provider’s event is applied', async () => {
      const { owner, workspaceId } = await setup();
      await upgrade(owner, workspaceId, 'PRO');

      const response = await as(owner)
        .post(`/workspaces/${workspaceId}/billing/cancel`)
        .expect(202);
      expect(response.body).toEqual({ requested: true });
      await until(
        () => planOf(workspaceId),
        (plan) => plan === 'FREE',
      );

      const overview = await as(owner).get(`/workspaces/${workspaceId}/billing`).expect(200);
      expect(overview.body).toMatchObject({
        plan: 'FREE',
        status: 'CANCELED',
        currentPeriodEnd: null,
      });
      // the paid invoice stays
      expect(overview.body.invoices).toHaveLength(1);
    });

    it('refuses to cancel a workspace that has no paid plan', async () => {
      const { owner, workspaceId } = await setup();
      const response = await as(owner)
        .post(`/workspaces/${workspaceId}/billing/cancel`)
        .expect(409);
      expect(response.body.code).toBe('CONFLICT');
    });

    it('lets the workspace buy a plan again after cancelling', async () => {
      const { owner, workspaceId } = await setup();
      await upgrade(owner, workspaceId, 'PRO');
      await as(owner).post(`/workspaces/${workspaceId}/billing/cancel`).expect(202);
      await until(
        () => planOf(workspaceId),
        (plan) => plan === 'FREE',
      );

      await upgrade(owner, workspaceId, 'PRO');
      const overview = await as(owner).get(`/workspaces/${workspaceId}/billing`).expect(200);
      expect(overview.body).toMatchObject({ plan: 'PRO', status: 'ACTIVE' });
      expect(overview.body.invoices).toHaveLength(2);
    });
  });

  describe('downgrade', () => {
    it('keeps what exceeds the new limit, reports it, and refuses to add more with an explanation', async () => {
      const { owner, workspaceId } = await setup();
      await upgrade(owner, workspaceId, 'PRO');
      await prisma.document.createMany({
        data: Array.from({ length: 25 }, (_, index) => ({
          workspaceId,
          createdBy: owner.id,
          title: `Doc ${index}`,
          position: `a${String(index).padStart(2, '0')}`,
        })),
      });

      await as(owner).post(`/workspaces/${workspaceId}/billing/cancel`).expect(202);
      await until(
        () => planOf(workspaceId),
        (plan) => plan === 'FREE',
      );

      const overview = await as(owner).get(`/workspaces/${workspaceId}/billing`).expect(200);
      expect(overview.body.overLimit).toEqual([{ kind: 'documents', current: 25, limit: 20 }]);
      expect(await prisma.document.count({ where: { workspaceId, deletedAt: null } })).toBe(25);

      const refused = await as(owner)
        .post(`/workspaces/${workspaceId}/documents`)
        .send({ title: 'One more' })
        .expect(403);
      expect(refused.body).toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: { kind: 'documents', limit: 20, current: 25, plan: 'FREE' },
      });
    });
  });
});
