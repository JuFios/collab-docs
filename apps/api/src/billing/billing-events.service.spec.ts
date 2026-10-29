import { Test } from '@nestjs/testing';
import { BILLING_EVENT_TYPES, type BillingEvent, type PlanTier } from '@collab-docs/shared';
import { getLoggerToken } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';
import { PlanLimitsService } from '../workspaces/plan-limits.service';
import { BillingEventsService } from './billing-events.service';
import { SubscriptionService } from './subscription.service';

const WORKSPACE = '0190b1c2-0000-7000-8000-0000000000aa';
const SESSION = '0190b1c2-0000-7000-8000-0000000000b1';
const SESSION_2 = '0190b1c2-0000-7000-8000-0000000000b2';
const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);

const eventId = (n: number) => `evt_${n.toString(16).padStart(32, '0')}`;

interface Session {
  id: string;
  workspaceId: string;
  plan: PlanTier;
  amountCents: number;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELED';
}

/**
 * An in-memory stand-in for the tables the processor touches. `$transaction` runs one callback at a time, which is
 * what `SELECT ... FOR UPDATE` on the event row does in Postgres: a second worker holding the same event waits
 * until the first has committed. (The same behaviour against the real database is in `billing.int.spec.ts`.)
 */
function fakeDatabase() {
  const events = new Map<string, { status: 'RECEIVED' | 'PROCESSED'; payload: BillingEvent }>();
  const sessions = new Map<string, Session>();
  const invoices = new Map<string, { checkoutSessionId: string; amountCents: number }>();
  const subscription = {
    plan: 'FREE' as PlanTier,
    status: 'ACTIVE',
    lastEventAt: null as Date | null,
    writes: 0,
  };

  const db = {
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, id: string) => {
      const row = events.get(id);
      return row ? [{ status: row.status, payload: row.payload }] : [];
    }),
    webhookEvent: {
      update: jest.fn(async ({ where }: { where: { eventId: string } }) => {
        events.get(where.eventId)!.status = 'PROCESSED';
      }),
    },
    checkoutSession: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null,
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: Session['status'] };
          data: { status: Session['status'] };
        }) => {
          const session = sessions.get(where.id);
          if (!session || session.status !== where.status) return { count: 0 };
          session.status = data.status;
          return { count: 1 };
        },
      ),
    },
    invoice: {
      create: jest.fn(
        async ({ data }: { data: { checkoutSessionId: string; amountCents: number } }) => {
          // the unique index on checkout_session_id
          if (invoices.has(data.checkoutSessionId)) throw new Error('unique constraint');
          invoices.set(data.checkoutSessionId, data);
        },
      ),
    },
    subscription: {
      findUnique: jest.fn(async () => ({
        plan: subscription.plan,
        lastEventAt: subscription.lastEventAt,
      })),
      upsert: jest.fn(
        async ({ update }: { update: { plan: PlanTier; status: string; lastEventAt: Date } }) => {
          Object.assign(subscription, update);
          subscription.writes += 1;
        },
      ),
    },
  };

  let tail: Promise<unknown> = Promise.resolve();
  const prisma = {
    $transaction: <T>(work: (tx: typeof db) => Promise<T>): Promise<T> => {
      const run = tail.then(() => work(db));
      tail = run.catch(() => undefined);
      return run;
    },
  };

  return {
    prisma,
    db,
    events,
    sessions,
    invoices,
    subscription,
    receive(id: number, type: string, data: Record<string, unknown>, created = T0 + id) {
      events.set(eventId(id), {
        status: 'RECEIVED',
        payload: { id: eventId(id), type, created, data },
      });
      return eventId(id);
    },
    addSession(id: string, plan: PlanTier = 'PRO', amountCents = 1200) {
      sessions.set(id, { id, workspaceId: WORKSPACE, plan, amountCents, status: 'PENDING' });
    },
  };
}

async function setup() {
  const fake = fakeDatabase();
  const logger = { info: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      BillingEventsService,
      SubscriptionService,
      { provide: PrismaService, useValue: fake.prisma },
      { provide: PlanLimitsService, useValue: { lockWorkspace: jest.fn() } },
      { provide: getLoggerToken(BillingEventsService.name), useValue: logger },
    ],
  }).compile();
  return { ...fake, logger, service: moduleRef.get(BillingEventsService) };
}

const completed = (checkoutSessionId = SESSION) => ({ checkoutSessionId });

describe('BillingEventsService', () => {
  it('applies a completed checkout: plan changed, session completed, one invoice', async () => {
    const { service, addSession, receive, subscription, invoices, sessions, events, logger } =
      await setup();
    addSession(SESSION);
    const id = receive(1, BILLING_EVENT_TYPES.checkoutCompleted, completed());

    await expect(service.process(id)).resolves.toMatchObject({ result: 'applied' });

    expect(subscription).toMatchObject({ plan: 'PRO', status: 'ACTIVE' });
    expect(sessions.get(SESSION)!.status).toBe('COMPLETED');
    expect([...invoices.values()]).toEqual([expect.objectContaining({ amountCents: 1200 })]);
    expect(events.get(id)!.status).toBe('PROCESSED');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'plan.changed',
        from: 'FREE',
        to: 'PRO',
        workspaceId: WORKSPACE,
      }),
      'plan.changed',
    );
  });

  it('has no effect when the same event is processed twice: one change, one invoice', async () => {
    const { service, addSession, receive, subscription, invoices, db } = await setup();
    addSession(SESSION);
    const id = receive(1, BILLING_EVENT_TYPES.checkoutCompleted, completed());

    expect((await service.process(id)).result).toBe('applied');
    expect((await service.process(id)).result).toBe('already_processed');

    expect(subscription.writes).toBe(1);
    expect(invoices.size).toBe(1);
    expect(db.invoice.create).toHaveBeenCalledTimes(1);
  });

  it('applies the event once when ten workers process it at the same time', async () => {
    const { service, addSession, receive, subscription, invoices, logger } = await setup();
    addSession(SESSION);
    const id = receive(1, BILLING_EVENT_TYPES.checkoutCompleted, completed());

    const results = await Promise.all(Array.from({ length: 10 }, () => service.process(id)));

    expect(results.filter((outcome) => outcome.result === 'applied')).toHaveLength(1);
    expect(results.filter((outcome) => outcome.result === 'already_processed')).toHaveLength(9);
    expect(subscription.writes).toBe(1);
    expect(invoices.size).toBe(1);
    expect(logger.info.mock.calls.filter(([, name]) => name === 'plan.changed')).toHaveLength(1);
  });

  it('charges a session once even when two different events complete it', async () => {
    const { service, addSession, receive, subscription, invoices } = await setup();
    addSession(SESSION);
    const first = receive(1, BILLING_EVENT_TYPES.checkoutCompleted, completed());
    const second = receive(2, BILLING_EVENT_TYPES.checkoutCompleted, completed());

    expect((await service.process(first)).result).toBe('applied');
    expect(await service.process(second)).toEqual({
      result: 'ignored',
      reason: 'session_already_settled',
    });

    expect(invoices.size).toBe(1);
    expect(subscription.writes).toBe(1);
  });

  it('records an older payment without letting it undo the plan a newer event set', async () => {
    const { service, addSession, receive, subscription, sessions, invoices } = await setup();
    addSession(SESSION, 'PRO', 1200);
    addSession(SESSION_2, 'TEAM', 4900);
    const older = receive(1, BILLING_EVENT_TYPES.checkoutCompleted, completed(SESSION), T0);
    const newer = receive(
      2,
      BILLING_EVENT_TYPES.checkoutCompleted,
      completed(SESSION_2),
      T0 + 5000,
    );

    expect((await service.process(newer)).result).toBe('applied');
    expect(await service.process(older)).toEqual({
      result: 'payment_not_applied',
      payment: {
        reason: 'stale',
        workspaceId: WORKSPACE,
        checkoutSessionId: SESSION,
        plan: 'PRO',
        amountCents: 1200,
      },
    });
    // replaying it changes nothing more
    expect(await service.process(older)).toEqual({ result: 'already_processed' });

    expect(subscription.plan).toBe('TEAM');
    expect(subscription.writes).toBe(1);
    expect(sessions.get(SESSION)!.status).toBe('COMPLETED');
    expect([...invoices.keys()].sort()).toEqual([SESSION, SESSION_2].sort());
  });

  it('records a payment for a session a newer checkout canceled, without changing the plan', async () => {
    const { service, addSession, receive, subscription, sessions, invoices } = await setup();
    addSession(SESSION, 'PRO', 1200);
    sessions.get(SESSION)!.status = 'CANCELED';
    const paid = receive(1, BILLING_EVENT_TYPES.checkoutCompleted, completed());

    expect(await service.process(paid)).toEqual({
      result: 'payment_not_applied',
      payment: {
        reason: 'session_canceled',
        workspaceId: WORKSPACE,
        checkoutSessionId: SESSION,
        plan: 'PRO',
        amountCents: 1200,
      },
    });
    expect(subscription.plan).toBe('FREE');
    expect(subscription.writes).toBe(0);
    expect(sessions.get(SESSION)!.status).toBe('COMPLETED');
    expect([...invoices.keys()]).toEqual([SESSION]);
  });

  it('ignores a cancellation that was overtaken by a later upgrade', async () => {
    const { service, addSession, receive, subscription } = await setup();
    addSession(SESSION);
    const cancel = receive(
      1,
      BILLING_EVENT_TYPES.subscriptionDeleted,
      { workspaceId: WORKSPACE },
      T0,
    );
    const upgrade = receive(2, BILLING_EVENT_TYPES.checkoutCompleted, completed(), T0 + 1000);

    await service.process(upgrade);
    expect(await service.process(cancel)).toEqual({ result: 'ignored', reason: 'stale' });
    expect(subscription).toMatchObject({ plan: 'PRO', status: 'ACTIVE' });
  });

  it('puts the workspace back on FREE when the subscription is deleted', async () => {
    const { service, addSession, receive, subscription } = await setup();
    addSession(SESSION);
    await service.process(receive(1, BILLING_EVENT_TYPES.checkoutCompleted, completed()));

    const outcome = await service.process(
      receive(2, BILLING_EVENT_TYPES.subscriptionDeleted, { workspaceId: WORKSPACE }),
    );

    expect(outcome).toMatchObject({ result: 'applied', change: { from: 'PRO', to: 'FREE' } });
    expect(subscription).toMatchObject({ plan: 'FREE', status: 'CANCELED' });
  });

  it('settles a failed payment without touching the subscription', async () => {
    const { service, addSession, receive, subscription, sessions, invoices } = await setup();
    addSession(SESSION);

    const outcome = await service.process(
      receive(1, BILLING_EVENT_TYPES.checkoutFailed, completed()),
    );

    expect(outcome).toEqual({ result: 'applied' });
    expect(sessions.get(SESSION)!.status).toBe('FAILED');
    expect(subscription.writes).toBe(0);
    expect(invoices.size).toBe(0);
  });

  it('marks events it cannot act on as processed, so they are not retried for ever', async () => {
    const { service, addSession, receive, events } = await setup();
    addSession(SESSION);
    const cases = [
      receive(1, 'invoice.paid', {}),
      receive(2, BILLING_EVENT_TYPES.checkoutCompleted, { checkoutSessionId: 'not-a-uuid' }),
      receive(
        3,
        BILLING_EVENT_TYPES.checkoutCompleted,
        completed('0190b1c2-0000-7000-8000-0000000000ff'),
      ),
    ];

    const reasons = [];
    for (const id of cases) {
      const outcome = await service.process(id);
      reasons.push(outcome.result === 'ignored' ? outcome.reason : outcome.result);
      expect(events.get(id)!.status).toBe('PROCESSED');
    }
    expect(reasons).toEqual(['unknown_type', 'malformed_data', 'unknown_session']);
  });

  it('reports an event it has no row for', async () => {
    const { service } = await setup();
    await expect(service.process(eventId(99))).resolves.toEqual({ result: 'missing' });
  });
});
