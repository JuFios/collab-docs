import { mockCheckoutSessionSchema } from '@collab-docs/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { MockCheckoutForm } from '@/components/billing/mock-checkout-form';
import { Button } from '@/components/ui/button';
import { isApiError } from '@/lib/api/errors';
import { apiPublic } from '@/lib/api/public';
import { PLAN_LABELS, formatMoney } from '@/lib/billing/format';
import { redeliverEnabled } from '@/lib/billing/mock-checkout';
import { billingPath } from '@/lib/billing/return';

export const metadata: Metadata = {
  title: 'Checkout',
  // the session id is the credential of the payment
  robots: { index: false },
  referrer: 'no-referrer',
};

const SETTLED = {
  COMPLETED: 'This payment has been completed.',
  FAILED: 'This payment was declined.',
} as const;

/**
 * The payment page of the mock provider, shaped like a hosted checkout. A public route like the real one: it holds
 * nothing but the session, and the session id decides. Never cached: the session changes when it is paid.
 */
export default async function MockCheckoutPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  if (!z.uuid().safeParse(sessionId).success) notFound();

  let session;
  try {
    session = await apiPublic(`/mock-provider/checkout-sessions/${encodeURIComponent(sessionId)}`, {
      schema: mockCheckoutSessionSchema,
      cache: 'no-store',
    });
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  }

  const amountLabel = formatMoney(session.amountCents);
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <p className="mb-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          Test mode: this is a simulated checkout, no money is charged.
        </p>
        <h1 className="text-xl font-semibold">Collab Docs {PLAN_LABELS[session.plan]}</h1>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          Monthly subscription for your workspace.
        </p>
        <dl className="mb-6 flex items-baseline justify-between border-y py-3 text-sm">
          <dt className="font-medium">Total due today</dt>
          <dd className="text-lg font-semibold">{amountLabel}</dd>
        </dl>
        {session.status === 'PENDING' ? (
          <MockCheckoutForm
            sessionId={session.id}
            amountLabel={amountLabel}
            showRedeliver={redeliverEnabled()}
          />
        ) : (
          <div className="grid gap-3">
            <p role="status" className="text-sm">
              {SETTLED[session.status]}
            </p>
            <Button asChild variant="outline">
              <Link href={billingPath(session.workspaceId)}>Back to billing</Link>
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
