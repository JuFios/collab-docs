import { type PlanInfo, type PlanTier, planCatalogList } from '@collab-docs/shared';
import { PLAN_LABELS, formatMoney } from '@/lib/billing/format';
import { formatBytes } from '@/lib/workspaces/labels';
import { cn } from '@/lib/utils';
import { CheckoutButton } from './checkout-button';

function features(plan: PlanInfo): string[] {
  return [
    `${plan.maxMembers} members`,
    plan.maxDocuments === null ? 'Unlimited documents' : `${plan.maxDocuments} documents`,
    `${formatBytes(plan.maxStorageBytes)} of storage`,
  ];
}

/** Free, Pro and Team side by side. Paid plans are bought through checkout; Free is what cancelling leads to. */
export function PlanCards({
  workspaceId,
  currentPlan,
}: {
  workspaceId: string;
  currentPlan: PlanTier;
}) {
  const plans = planCatalogList();
  const currentPrice = plans.find((plan) => plan.plan === currentPlan)?.priceCents ?? 0;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {plans.map((plan) => {
        const current = plan.plan === currentPlan;
        return (
          <article
            key={plan.plan}
            aria-labelledby={`plan-${plan.plan}`}
            className={cn(
              'grid content-start gap-4 rounded-lg border bg-card p-4',
              current && 'border-primary ring-1 ring-primary',
            )}
          >
            <div className="grid gap-1">
              <h3 id={`plan-${plan.plan}`} className="flex items-center gap-2 font-semibold">
                {PLAN_LABELS[plan.plan]}
                {current ? (
                  <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                    Current
                  </span>
                ) : null}
              </h3>
              <p className="text-2xl font-semibold">
                {formatMoney(plan.priceCents)}
                <span className="text-sm font-normal text-muted-foreground"> / month</span>
              </p>
            </div>
            <ul className="grid gap-1 text-sm text-muted-foreground">
              {features(plan).map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            {plan.plan === 'FREE' || current ? null : (
              <CheckoutButton
                workspaceId={workspaceId}
                plan={plan.plan}
                variant={plan.priceCents > currentPrice ? 'default' : 'outline'}
                label={`${plan.priceCents > currentPrice ? 'Upgrade' : 'Switch'} to ${PLAN_LABELS[plan.plan]}`}
              />
            )}
          </article>
        );
      })}
    </div>
  );
}
