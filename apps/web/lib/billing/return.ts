import { type PlanTier, planTierSchema } from '@collab-docs/shared';

/**
 * What the billing page is told through its query string when the user comes back from the payment page (or has just
 * asked to cancel): the plan the webhook is about to set, or a declined payment. The plan only changes when the
 * webhook has been applied, which takes a few seconds after the provider has answered.
 */
export interface BillingReturn {
  awaiting?: PlanTier;
  declined?: boolean;
}

export function billingPath(workspaceId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/billing`;
}

export function billingReturnUrl(workspaceId: string, result: BillingReturn): string {
  const params = new URLSearchParams();
  if (result.awaiting) params.set('awaiting', result.awaiting);
  if (result.declined) params.set('payment', 'declined');
  const query = params.toString();
  return query ? `${billingPath(workspaceId)}?${query}` : billingPath(workspaceId);
}

type SearchParams = Record<string, string | string[] | undefined>;

export function parseBillingReturn(searchParams: SearchParams): BillingReturn {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const awaiting = planTierSchema.safeParse(first(searchParams.awaiting));
  return {
    ...(awaiting.success ? { awaiting: awaiting.data } : {}),
    ...(first(searchParams.payment) === 'declined' ? { declined: true } : {}),
  };
}
