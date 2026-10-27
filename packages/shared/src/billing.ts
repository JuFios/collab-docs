import { z } from 'zod';
import { type LimitKind, type PlanTier, PLAN_CATALOG, limitFor, planTierSchema } from './plans';

/** Plans that can be bought; FREE is what a workspace falls back to. */
export const CHECKOUT_PLANS = ['PRO', 'TEAM'] as const;
export type CheckoutPlan = (typeof CHECKOUT_PLANS)[number];

export const createCheckoutInputSchema = z.object({ plan: z.enum(CHECKOUT_PLANS) });
export type CreateCheckoutInput = z.infer<typeof createCheckoutInputSchema>;

export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'CANCELED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** A paid period lasts this long from the event that paid it (the mock provider has no renewals). */
export const SUBSCRIPTION_PERIOD_DAYS = 30;

/** Events of the payment provider that the webhook understands. */
export const BILLING_EVENT_TYPES = {
  checkoutCompleted: 'checkout.session.completed',
  checkoutFailed: 'checkout.session.failed',
  subscriptionDeleted: 'customer.subscription.deleted',
} as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[keyof typeof BILLING_EVENT_TYPES];

/** Header of a signed delivery: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. */
export const MOCK_SIGNATURE_HEADER = 'Mock-Signature';
/** A delivery whose timestamp differs from the receiver's clock by more than this is refused (replay window). */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/** `evt_` + 32 hex characters. */
export const BILLING_EVENT_ID_PATTERN = /^evt_[0-9a-f]{32}$/;

/** The signed body of a delivery. `created` is epoch milliseconds, so two events of one second keep their order. */
export const billingEventSchema = z.object({
  id: z.string().regex(BILLING_EVENT_ID_PATTERN),
  type: z.string().min(1).max(100),
  created: z.number().int().positive(),
  data: z.record(z.string(), z.unknown()),
});
export type BillingEvent = z.infer<typeof billingEventSchema>;

export const checkoutEventDataSchema = z.object({ checkoutSessionId: z.uuid() });
export const subscriptionEventDataSchema = z.object({ workspaceId: z.uuid() });

export interface PlanInfo {
  plan: PlanTier;
  priceCents: number;
  maxMembers: number;
  /** `null` = unlimited. */
  maxDocuments: number | null;
  maxStorageBytes: number;
}

export function planCatalogList(): PlanInfo[] {
  return (Object.keys(PLAN_CATALOG) as PlanTier[]).map((plan) => ({
    plan,
    priceCents: PLAN_CATALOG[plan].priceCents,
    maxMembers: PLAN_CATALOG[plan].maxMembers,
    maxDocuments: PLAN_CATALOG[plan].maxDocuments,
    maxStorageBytes: PLAN_CATALOG[plan].maxStorageBytes,
  }));
}

/** What a workspace holds against one limit. */
export const usageFigureSchema = z.object({
  kind: z.enum(['members', 'documents', 'storage']),
  current: z.number(),
  /** `null` = unlimited. */
  limit: z.number().nullable(),
});
export type UsageFigure = z.infer<typeof usageFigureSchema>;

/**
 * The figures that exceed the limits of `plan`. After a downgrade a workspace may hold more than the new plan
 * allows: what exists stays, and creating more is refused until the figure is back under the limit.
 */
export function overLimit(plan: PlanTier, current: Record<LimitKind, number>): UsageFigure[] {
  const kinds: LimitKind[] = ['members', 'documents', 'storage'];
  return kinds
    .map((kind) => ({ kind, current: current[kind], limit: limitFor(plan, kind) }))
    .filter((figure) => figure.limit !== null && figure.current > figure.limit);
}

export const invoiceInfoSchema = z.object({
  id: z.uuid(),
  plan: planTierSchema,
  amountCents: z.number().int(),
  createdAt: z.string(),
});
export type InvoiceInfo = z.infer<typeof invoiceInfoSchema>;

export const checkoutStartedSchema = z.object({
  sessionId: z.uuid(),
  /** Path of the page where the payment is made. */
  checkoutUrl: z.string().startsWith('/'),
});
export type CheckoutStarted = z.infer<typeof checkoutStartedSchema>;

/** `GET /workspaces/:id/billing`. */
export const billingOverviewSchema = z.object({
  plan: planTierSchema,
  status: z.enum(SUBSCRIPTION_STATUSES),
  currentPeriodEnd: z.string().nullable(),
  usage: z.array(usageFigureSchema),
  overLimit: z.array(usageFigureSchema),
  invoices: z.array(invoiceInfoSchema),
});
export type BillingOverviewData = z.infer<typeof billingOverviewSchema>;

export const CHECKOUT_SESSION_STATUSES = ['PENDING', 'COMPLETED', 'FAILED'] as const;

/** The checkout session as the provider's payment page shows it. */
export const mockCheckoutSessionSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  plan: planTierSchema,
  amountCents: z.number().int(),
  status: z.enum(CHECKOUT_SESSION_STATUSES),
});
export type MockCheckoutSession = z.infer<typeof mockCheckoutSessionSchema>;

/** Answer of the provider's `complete`, `fail` and `redeliver`: the id of the event it delivers. */
export const eventIssuedSchema = z.object({ eventId: z.string().regex(BILLING_EVENT_ID_PATTERN) });
