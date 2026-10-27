'use client';

import type { PlanTier } from '@collab-docs/shared';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PLAN_LABELS } from '@/lib/billing/format';
import { Notice } from './notice';

export const POLL_INTERVAL_MS = 1500;
/** About 45 s: the webhook is retried with backoff, so a short outage still resolves within that. */
export const MAX_POLLS = 30;

/**
 * The provider has answered, but the plan changes only when the webhook has been applied. Until then the page asks
 * the server for a fresh render every few seconds, for a bounded time. The rest of the page stays a Server Component;
 * this is the only client piece in the flow that waits.
 */
export function AwaitingConfirmation({
  expectedPlan,
  currentPlan,
  billingPath,
}: {
  expectedPlan: PlanTier;
  currentPlan: PlanTier;
  billingPath: string;
}) {
  const router = useRouter();
  const [round, setRound] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const confirmed = currentPlan === expectedPlan;

  useEffect(() => {
    if (confirmed) {
      toast.success(`The workspace is now on the ${PLAN_LABELS[expectedPlan]} plan.`);
      router.replace(billingPath);
      return;
    }
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        setTimedOut(true);
        return;
      }
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [confirmed, expectedPlan, billingPath, router, round]);

  if (confirmed) return null;

  if (timedOut) {
    return (
      <Notice tone="warning" title="Still waiting for the confirmation">
        <p>The payment provider has not confirmed yet. Your plan will update as soon as it does.</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => {
            setTimedOut(false);
            setRound((value) => value + 1);
          }}
        >
          Check again
        </Button>
      </Notice>
    );
  }

  return (
    <Notice tone="info" title="Waiting for the payment confirmation">
      <p className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        The {PLAN_LABELS[expectedPlan]} plan applies as soon as the provider confirms. This usually
        takes a few seconds.
      </p>
    </Notice>
  );
}
