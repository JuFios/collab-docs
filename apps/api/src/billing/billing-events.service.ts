import { Injectable } from '@nestjs/common';
import type { Prisma } from '@collab-docs/db';
import {
  BILLING_EVENT_TYPES,
  SUBSCRIPTION_PERIOD_DAYS,
  type BillingEvent,
  type PlanTier,
  billingEventSchema,
  checkoutEventDataSchema,
  subscriptionEventDataSchema,
} from '@collab-docs/shared';
import { InjectPinoLogger, PinoLogger, logEvent } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';
import { PlanLimitsService } from '../workspaces/plan-limits.service';
import { SubscriptionService } from './subscription.service';

interface PlanChange {
  workspaceId: string;
  from: PlanTier;
  to: PlanTier;
  checkoutSessionId?: string;
}

type EventOutcome =
  | { result: 'applied'; change?: PlanChange }
  | { result: 'ignored'; reason: string }
  | { result: 'already_processed' }
  | { result: 'missing' };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Applies a received webhook event to the database (spec §8). Everything happens in one transaction that starts by
 * locking the event row, so a second worker holding the same event waits and then finds it `PROCESSED`; the
 * conditional `UPDATE checkout_sessions ... WHERE status = 'PENDING'` and the unique `invoices.checkout_session_id`
 * keep a session from being charged twice even if two different events refer to it.
 */
@Injectable()
export class BillingEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planLimits: PlanLimitsService,
    private readonly subscriptions: SubscriptionService,
    @InjectPinoLogger(BillingEventsService.name) private readonly logger: PinoLogger,
  ) {}

  async process(eventId: string): Promise<EventOutcome> {
    let type: string | undefined;
    const outcome = await this.prisma.$transaction(async (tx): Promise<EventOutcome> => {
      const [row] = await tx.$queryRaw<Array<{ status: string; payload: unknown }>>`
        SELECT status::text AS status, payload FROM webhook_events WHERE event_id = ${eventId} FOR UPDATE`;
      if (!row) return { result: 'missing' };
      if (row.status === 'PROCESSED') return { result: 'already_processed' };

      const event = billingEventSchema.safeParse(row.payload);
      type = event.success ? event.data.type : undefined;
      const result: EventOutcome = event.success
        ? await this.apply(tx, event.data)
        : { result: 'ignored', reason: 'malformed_event' };
      await tx.webhookEvent.update({
        where: { eventId },
        data: { status: 'PROCESSED', processedAt: new Date() },
      });
      return result;
    });

    switch (outcome.result) {
      case 'applied':
        if (outcome.change) logEvent(this.logger, 'plan.changed', { eventId, ...outcome.change });
        break;
      case 'ignored':
        logEvent(this.logger, 'webhook.ignored', { eventId, type, reason: outcome.reason });
        break;
      case 'already_processed':
        logEvent(this.logger, 'webhook.already_processed', { eventId });
        break;
      case 'missing':
        logEvent(this.logger, 'webhook.event_missing', { eventId });
        break;
    }
    return outcome;
  }

  private apply(tx: Prisma.TransactionClient, event: BillingEvent): Promise<EventOutcome> {
    switch (event.type) {
      case BILLING_EVENT_TYPES.checkoutCompleted:
        return this.checkoutCompleted(tx, event);
      case BILLING_EVENT_TYPES.checkoutFailed:
        return this.checkoutFailed(tx, event);
      case BILLING_EVENT_TYPES.subscriptionDeleted:
        return this.subscriptionDeleted(tx, event);
      default:
        return Promise.resolve({ result: 'ignored', reason: 'unknown_type' });
    }
  }

  private async checkoutCompleted(
    tx: Prisma.TransactionClient,
    event: BillingEvent,
  ): Promise<EventOutcome> {
    const data = checkoutEventDataSchema.safeParse(event.data);
    if (!data.success) return { result: 'ignored', reason: 'malformed_data' };
    const session = await tx.checkoutSession.findUnique({
      where: { id: data.data.checkoutSessionId },
    });
    if (!session) return { result: 'ignored', reason: 'unknown_session' };

    await this.planLimits.lockWorkspace(tx, session.workspaceId);
    const eventAt = new Date(event.created);
    if (await this.subscriptions.isStale(tx, session.workspaceId, eventAt)) {
      return { result: 'ignored', reason: 'stale' };
    }

    const settled = await tx.checkoutSession.updateMany({
      where: { id: session.id, status: 'PENDING' },
      data: { status: 'COMPLETED', settledAt: new Date() },
    });
    if (settled.count !== 1) return { result: 'ignored', reason: 'session_already_settled' };

    const from = await this.subscriptions.apply(tx, session.workspaceId, {
      plan: session.plan,
      status: 'ACTIVE',
      currentPeriodEnd: new Date(eventAt.getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY_MS),
      eventAt,
    });
    await tx.invoice.create({
      data: {
        workspaceId: session.workspaceId,
        checkoutSessionId: session.id,
        eventId: event.id,
        plan: session.plan,
        amountCents: session.amountCents,
      },
    });
    return {
      result: 'applied',
      change: {
        workspaceId: session.workspaceId,
        from,
        to: session.plan,
        checkoutSessionId: session.id,
      },
    };
  }

  /** A failed payment settles the session and leaves the subscription (and its clock) alone. */
  private async checkoutFailed(
    tx: Prisma.TransactionClient,
    event: BillingEvent,
  ): Promise<EventOutcome> {
    const data = checkoutEventDataSchema.safeParse(event.data);
    if (!data.success) return { result: 'ignored', reason: 'malformed_data' };
    const settled = await tx.checkoutSession.updateMany({
      where: { id: data.data.checkoutSessionId, status: 'PENDING' },
      data: { status: 'FAILED', settledAt: new Date() },
    });
    return settled.count === 1
      ? { result: 'applied' }
      : { result: 'ignored', reason: 'session_already_settled' };
  }

  private async subscriptionDeleted(
    tx: Prisma.TransactionClient,
    event: BillingEvent,
  ): Promise<EventOutcome> {
    const data = subscriptionEventDataSchema.safeParse(event.data);
    if (!data.success) return { result: 'ignored', reason: 'malformed_data' };
    const { workspaceId } = data.data;

    await this.planLimits.lockWorkspace(tx, workspaceId);
    const eventAt = new Date(event.created);
    if (await this.subscriptions.isStale(tx, workspaceId, eventAt)) {
      return { result: 'ignored', reason: 'stale' };
    }
    const from = await this.subscriptions.apply(tx, workspaceId, {
      plan: 'FREE',
      status: 'CANCELED',
      currentPeriodEnd: null,
      eventAt,
    });
    return { result: 'applied', change: { workspaceId, from, to: 'FREE' } };
  }
}
