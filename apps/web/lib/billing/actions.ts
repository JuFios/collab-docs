'use server';

import { CHECKOUT_PLANS, checkoutStartedSchema } from '@collab-docs/shared';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { apiServer } from '@/lib/api/server';
import { textField } from '@/lib/auth/form-state';
import { type ActionState, failureState } from '@/lib/workspaces/action-state';
import { billingReturnUrl } from './return';

// Posted by plain forms (hidden inputs), so they work without JavaScript; success moves the user on with `redirect`.
const startCheckoutSchema = z.object({
  workspaceId: z.uuid(),
  plan: z.enum(CHECKOUT_PLANS),
});

/** Creates a checkout session and sends the user to the payment page the api points at. */
export async function startCheckoutAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = startCheckoutSchema.safeParse({
    workspaceId: textField(formData, 'workspaceId'),
    plan: textField(formData, 'plan'),
  });
  if (!parsed.success) return { formError: 'Invalid request.' };
  let checkoutUrl: string;
  try {
    const started = await apiServer(
      `/workspaces/${encodeURIComponent(parsed.data.workspaceId)}/billing/checkout`,
      { method: 'POST', body: { plan: parsed.data.plan }, schema: checkoutStartedSchema },
    );
    checkoutUrl = started.checkoutUrl;
  } catch (error) {
    return failureState(error);
  }
  redirect(checkoutUrl);
}

/** Asks the provider to cancel; the plan drops to Free when the webhook for that has been applied. */
export async function cancelSubscriptionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z.object({ workspaceId: z.uuid() }).safeParse({
    workspaceId: textField(formData, 'workspaceId'),
  });
  if (!parsed.success) return { formError: 'Invalid request.' };
  try {
    await apiServer(`/workspaces/${encodeURIComponent(parsed.data.workspaceId)}/billing/cancel`, {
      method: 'POST',
    });
  } catch (error) {
    return failureState(error);
  }
  redirect(billingReturnUrl(parsed.data.workspaceId, { awaiting: 'FREE' }));
}
