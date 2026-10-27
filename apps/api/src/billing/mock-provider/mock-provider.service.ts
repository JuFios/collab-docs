import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@collab-docs/db';
import { BILLING_EVENT_TYPES, type BillingEvent } from '@collab-docs/shared';
import { AppException, QUEUE_NAMES, QueueService } from '@collab-docs/nest';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The stand-in for a payment provider such as Stripe. It owns what a provider owns: the events it issued (so that
 * any of them can be delivered again) and the delivery to the webhook. It never touches the subscription; the
 * only way a payment changes a plan is the signed event arriving at the webhook.
 */
@Injectable()
export class MockProviderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  async checkoutSession(id: string) {
    const session = await this.prisma.checkoutSession.findUnique({
      where: { id },
      select: { id: true, workspaceId: true, plan: true, amountCents: true, status: true },
    });
    if (!session) throw new AppException('NOT_FOUND', 'Checkout session not found');
    return session;
  }

  /** The customer paid. The session stays PENDING until the webhook event has been applied. */
  complete(id: string): Promise<string> {
    return this.settle(id, BILLING_EVENT_TYPES.checkoutCompleted);
  }

  /** The payment was declined. */
  fail(id: string): Promise<string> {
    return this.settle(id, BILLING_EVENT_TYPES.checkoutFailed);
  }

  async cancelSubscription(workspaceId: string): Promise<void> {
    await this.emit(BILLING_EVENT_TYPES.subscriptionDeleted, { workspaceId });
  }

  /** Delivers an event again, as the "resend" button of a real provider's dashboard does. */
  async redeliver(eventId: string): Promise<void> {
    const event = await this.prisma.mockProviderEvent.findUnique({
      where: { id: eventId },
      select: { id: true },
    });
    if (!event) throw new AppException('NOT_FOUND', 'Event not found');
    await this.enqueueDelivery(eventId);
  }

  /** A session gets one outcome; paying twice (a double click) is refused instead of producing a second event. */
  private async settle(
    sessionId: string,
    type: typeof BILLING_EVENT_TYPES.checkoutCompleted | typeof BILLING_EVENT_TYPES.checkoutFailed,
  ): Promise<string> {
    const session = await this.checkoutSession(sessionId);
    const issued = await this.prisma.mockProviderEvent.count({
      where: {
        checkoutSessionId: sessionId,
        type: { in: [BILLING_EVENT_TYPES.checkoutCompleted, BILLING_EVENT_TYPES.checkoutFailed] },
      },
    });
    if (session.status !== 'PENDING' || issued > 0) {
      throw new AppException('CONFLICT', 'The checkout session was already settled');
    }
    return this.emit(type, { checkoutSessionId: sessionId }, sessionId);
  }

  private async emit(
    type: string,
    data: Record<string, unknown>,
    checkoutSessionId?: string,
  ): Promise<string> {
    const event: BillingEvent = {
      id: `evt_${randomBytes(16).toString('hex')}`,
      type,
      created: Date.now(),
      data,
    };
    await this.prisma.mockProviderEvent.create({
      data: {
        id: event.id,
        type,
        checkoutSessionId: checkoutSessionId ?? null,
        payload: event as unknown as Prisma.InputJsonValue,
      },
    });
    await this.enqueueDelivery(event.id);
    return event.id;
  }

  /** One job per delivery (no job id): a resend must not be mistaken for the delivery it repeats. */
  private async enqueueDelivery(eventId: string): Promise<void> {
    try {
      await this.queues.add(QUEUE_NAMES.billingDelivery, 'deliver', { eventId });
    } catch (error) {
      this.queues.recordEnqueueFailure(
        QUEUE_NAMES.billingDelivery,
        'billing.delivery_enqueue_failed',
        {
          eventId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        `Event ${eventId} is stored but not queued, redeliver it`,
      );
    }
  }
}
