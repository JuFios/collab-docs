import { Inject, Injectable } from '@nestjs/common';
import {
  PLAN_CATALOG,
  type CheckoutPlan,
  type CheckoutStarted,
  type InvoiceInfo,
  type PlanTier,
  type SubscriptionStatus,
  type UsageFigure,
  overLimit,
  planCatalogList,
} from '@collab-docs/shared';
import { AppException } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';
import { PlanLimitsService } from '../workspaces/plan-limits.service';
import { BILLING_PROVIDER, type BillingProvider } from './billing-provider';

const INVOICE_LIMIT = 50;

interface BillingOverview {
  plan: PlanTier;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  usage: UsageFigure[];
  overLimit: UsageFigure[];
  invoices: InvoiceInfo[];
}

/**
 * What a workspace admin does with billing. Nothing here changes the plan: checkout and cancellation are requests to
 * the provider, whose answer arrives as a webhook event (`BillingEventsService`).
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planLimits: PlanLimitsService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  plans() {
    return planCatalogList();
  }

  async overview(workspaceId: string): Promise<BillingOverview> {
    const [usage, subscription, invoices] = await Promise.all([
      this.planLimits.usage(workspaceId),
      this.prisma.subscription.findUnique({ where: { workspaceId } }),
      this.prisma.invoice.findMany({
        where: { workspaceId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: INVOICE_LIMIT,
      }),
    ]);
    const current = {
      members: usage.members.current + usage.members.pendingInvites,
      documents: usage.documents.current,
      storage: usage.storage.currentBytes,
    };
    return {
      plan: usage.plan,
      status: subscription?.status ?? 'ACTIVE',
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      usage: [
        { kind: 'members', current: current.members, limit: usage.members.limit },
        { kind: 'documents', current: current.documents, limit: usage.documents.limit },
        { kind: 'storage', current: current.storage, limit: usage.storage.limitBytes },
      ],
      overLimit: overLimit(usage.plan, current),
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        plan: invoice.plan,
        amountCents: invoice.amountCents,
        createdAt: invoice.createdAt.toISOString(),
      })),
    };
  }

  async checkout(workspaceId: string, plan: CheckoutPlan): Promise<CheckoutStarted> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { workspaceId },
      select: { plan: true, status: true },
    });
    if (subscription?.plan === plan && subscription.status === 'ACTIVE') {
      throw new AppException('CONFLICT', `The workspace is already on the ${plan} plan`);
    }
    const session = await this.prisma.checkoutSession.create({
      data: { workspaceId, plan, amountCents: PLAN_CATALOG[plan].priceCents },
      select: { id: true },
    });
    return { sessionId: session.id, checkoutUrl: this.provider.checkoutUrl(session.id) };
  }

  async cancel(workspaceId: string): Promise<void> {
    const plan = await this.planLimits.planOf(this.prisma, workspaceId);
    if (plan === 'FREE')
      throw new AppException('CONFLICT', 'The workspace has no paid plan to cancel');
    await this.provider.cancelSubscription(workspaceId);
  }
}
