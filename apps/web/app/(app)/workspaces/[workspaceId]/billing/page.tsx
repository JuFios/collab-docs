import { PLAN_CATALOG, roleAtLeast } from '@collab-docs/shared';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AwaitingConfirmation } from '@/components/billing/awaiting-confirmation';
import { CancelSubscriptionButton } from '@/components/billing/cancel-subscription-button';
import { Notice } from '@/components/billing/notice';
import { PlanCards } from '@/components/billing/plan-cards';
import { UsageMeter } from '@/components/billing/usage-meter';
import { EmptyState, ForbiddenState } from '@/components/states';
import { getBilling } from '@/lib/billing/data';
import { LIMIT_LABELS, PLAN_LABELS, formatFigure, formatMoney } from '@/lib/billing/format';
import { billingPath, parseBillingReturn } from '@/lib/billing/return';
import { requireWorkspace } from '@/lib/workspaces/data';
import { formatDate } from '@/lib/workspaces/labels';

export const metadata: Metadata = { title: 'Billing' };

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-3 rounded-lg border bg-card p-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const workspace = await requireWorkspace(workspaceId);
  // the nav hides this page from editors and viewers; opening the URL directly lands here
  if (!roleAtLeast(workspace.role, 'ADMIN')) {
    return <ForbiddenState description="Only workspace admins and owners can manage billing." />;
  }

  const billing = await getBilling(workspaceId);
  const returned = parseBillingReturn(query);
  const paid = billing.plan !== 'FREE';

  return (
    <div className="grid gap-6">
      {returned.awaiting ? (
        <AwaitingConfirmation
          expectedPlan={returned.awaiting}
          currentPlan={billing.plan}
          billingPath={billingPath(workspaceId)}
        />
      ) : null}
      {returned.declined ? (
        <Notice tone="error" title="The payment was declined">
          Nothing was charged and the plan has not changed. You can start the checkout again below.
        </Notice>
      ) : null}
      {billing.overLimit.length > 0 ? (
        <Notice
          tone="warning"
          title={`This workspace is over the ${PLAN_LABELS[billing.plan]} limits`}
        >
          <p>
            {billing.overLimit
              .map(
                (figure) =>
                  `${LIMIT_LABELS[figure.kind].toLowerCase()}: ${formatFigure(figure.kind, figure.current)} of ${formatFigure(figure.kind, figure.limit ?? 0)}`,
              )
              .join(', ')}
            . Everything that exists stays, but creating more is blocked until usage is back under
            the limits or the plan is upgraded.
          </p>
        </Notice>
      ) : null}
      {billing.status === 'CANCELED' && !paid ? (
        <Notice tone="info" title="The subscription was canceled">
          The workspace is on the Free plan. Pick a plan below to subscribe again.
        </Notice>
      ) : null}

      <Section id="plan-heading" title="Current plan">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="grid gap-1">
            <p className="text-lg font-semibold">
              {PLAN_LABELS[billing.plan]}{' '}
              <span className="text-sm font-normal text-muted-foreground">
                · {formatMoney(PLAN_CATALOG[billing.plan].priceCents)} / month
              </span>
            </p>
            <p className="text-sm text-muted-foreground">
              {paid && billing.currentPeriodEnd
                ? `Paid through ${formatDate(billing.currentPeriodEnd)}.`
                : paid
                  ? 'Active subscription.'
                  : 'No subscription: the workspace uses the free limits.'}
            </p>
          </div>
          {paid ? <CancelSubscriptionButton workspaceId={workspaceId} /> : null}
        </div>
      </Section>

      <Section id="usage-heading" title="Usage">
        <div className="grid gap-4 sm:grid-cols-3">
          {billing.usage.map((figure) => (
            <UsageMeter key={figure.kind} {...figure} />
          ))}
        </div>
      </Section>

      <Section id="plans-heading" title="Plans">
        <PlanCards workspaceId={workspaceId} currentPlan={billing.plan} />
      </Section>

      <Section id="invoices-heading" title="Invoices">
        {billing.invoices.length === 0 ? (
          <EmptyState
            title="No invoices yet"
            description="Payments show up here once they are confirmed."
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Date
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Plan
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {billing.invoices.map((invoice) => (
                <tr key={invoice.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">{formatDate(invoice.createdAt)}</td>
                  <td className="py-2 pr-4">{PLAN_LABELS[invoice.plan]}</td>
                  <td className="py-2 text-right">{formatMoney(invoice.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
