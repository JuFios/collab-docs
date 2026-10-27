'use server';

import { CHECKOUT_PLANS, checkoutStartedSchema } from '@collab-docs/shared';
import { z } from 'zod';
import { apiServer } from '@/lib/api/server';
import { type ActionState, failureState } from '@/lib/workspaces/action-state';
import { billingReturnUrl } from './return';

// Like the workspace actions, these return data and the calling component navigates (see `useActionFeedback`).
const startCheckoutSchema = z.object({
  workspaceId: z.uuid(),
  plan: z.enum(CHECKOUT_PLANS),
});

/** Creates a checkout session and sends the user to the payment page the api points at. */
export async function startCheckoutAction(input: {
  workspaceId: string;
  plan: string;
}): Promise<ActionState> {
  const parsed = startCheckoutSchema.safeParse(input);
  if (!parsed.success) return { formError: 'Invalid request.' };
  try {
    const started = await apiServer(
      `/workspaces/${encodeURIComponent(parsed.data.workspaceId)}/billing/checkout`,
      { method: 'POST', body: { plan: parsed.data.plan }, schema: checkoutStartedSchema },
    );
    return { ok: true, redirectTo: started.checkoutUrl };
  } catch (error) {
    return failureState(error);
  }
}

/** Asks the provider to cancel; the plan drops to Free when the webhook for that has been applied. */
export async function cancelSubscriptionAction(input: {
  workspaceId: string;
}): Promise<ActionState> {
  const parsed = z.object({ workspaceId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { formError: 'Invalid request.' };
  try {
    await apiServer(`/workspaces/${encodeURIComponent(parsed.data.workspaceId)}/billing/cancel`, {
      method: 'POST',
    });
  } catch (error) {
    return failureState(error);
  }
  return {
    ok: true,
    notice: 'Cancellation requested.',
    redirectTo: billingReturnUrl(parsed.data.workspaceId, { awaiting: 'FREE' }),
  };
}
