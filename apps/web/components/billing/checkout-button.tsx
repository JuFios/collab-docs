'use client';

import type { CheckoutPlan } from '@collab-docs/shared';
import { Button } from '@/components/ui/button';
import { startCheckoutAction } from '@/lib/billing/actions';
import { useActionRunner } from './use-action-runner';

/** Starts a checkout for `plan` and follows the api to the payment page. */
export function CheckoutButton({
  workspaceId,
  plan,
  label,
  variant = 'default',
}: {
  workspaceId: string;
  plan: CheckoutPlan;
  label: string;
  variant?: 'default' | 'outline';
}) {
  const { state, pending, execute } = useActionRunner(startCheckoutAction);
  return (
    <div className="grid gap-2">
      <Button variant={variant} disabled={pending} onClick={() => execute({ workspaceId, plan })}>
        {pending ? 'Opening checkout…' : label}
      </Button>
      {state.formError && !state.planLimit ? (
        <p role="alert" className="text-xs text-destructive">
          {state.formError}
        </p>
      ) : null}
    </div>
  );
}
