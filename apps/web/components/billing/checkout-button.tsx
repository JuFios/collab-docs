'use client';

import type { CheckoutPlan } from '@collab-docs/shared';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { startCheckoutAction } from '@/lib/billing/actions';
import { useActionFeedback } from '@/components/workspaces/use-action-feedback';

/** Starts a checkout for `plan`; the action redirects to the payment page the api points at. */
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
  const [state, formAction, pending] = useActionState(startCheckoutAction, {});
  useActionFeedback(state);
  return (
    <form action={formAction} className="grid gap-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="plan" value={plan} />
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? 'Opening checkout…' : label}
      </Button>
      {state.formError && !state.planLimit ? (
        <p role="alert" className="text-xs text-destructive">
          {state.formError}
        </p>
      ) : null}
    </form>
  );
}
