import { Injectable } from '@nestjs/common';
import type { Prisma } from '@collab-docs/db';
import type { PlanTier, SubscriptionStatus } from '@collab-docs/shared';

interface SubscriptionChange {
  plan: PlanTier;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  /** When the provider issued the event that causes the change. */
  eventAt: Date;
}

/**
 * The only writer of `subscriptions` after a workspace is created. Callers hold the workspace row lock
 * (`PlanLimitsService.lockWorkspace`) so that `isStale` and `apply` see and leave a consistent row.
 */
@Injectable()
export class SubscriptionService {
  /**
   * True when a newer event has already been applied: deliveries can overtake one another, and applying the
   * older one afterwards would undo the newer one.
   */
  async isStale(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    eventAt: Date,
  ): Promise<boolean> {
    const subscription = await tx.subscription.findUnique({
      where: { workspaceId },
      select: { lastEventAt: true },
    });
    return subscription?.lastEventAt != null && eventAt < subscription.lastEventAt;
  }

  /** Sets plan and status; returns the plan the workspace had before. */
  async apply(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    change: SubscriptionChange,
  ): Promise<PlanTier> {
    const before = await tx.subscription.findUnique({
      where: { workspaceId },
      select: { plan: true },
    });
    const data = {
      plan: change.plan,
      status: change.status,
      currentPeriodEnd: change.currentPeriodEnd,
      lastEventAt: change.eventAt,
    };
    await tx.subscription.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
    return before?.plan ?? 'FREE';
  }
}
