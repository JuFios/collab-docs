'use server';

import { eventIssuedSchema, mockCheckoutSessionSchema } from '@collab-docs/shared';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { apiServer } from '@/lib/api/server';
import { textField } from '@/lib/auth/form-state';
import { type ActionState, failureState } from '@/lib/workspaces/action-state';
import { redeliverEnabled } from './mock-checkout';
import { billingReturnUrl } from './return';

const OUTCOMES = ['pay', 'fail', 'pay_and_redeliver'] as const;
const settleSchema = z.object({ sessionId: z.uuid(), outcome: z.enum(OUTCOMES) });

/**
 * What the buttons of the payment page post (a plain form: it works without JavaScript). The api's mock-provider endpoints are public, like the hosted page of a
 * real provider: the session id is the credential. The session is read again here so that the page the user returns to
 * comes from the provider's data and not from the submitted form.
 */
export async function settleCheckoutAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = settleSchema.safeParse({
    sessionId: textField(formData, 'sessionId'),
    outcome: textField(formData, 'outcome'),
  });
  if (!parsed.success) return { formError: 'Invalid request.' };
  const { sessionId, outcome } = parsed.data;
  if (outcome === 'pay_and_redeliver' && !redeliverEnabled()) {
    return { formError: 'This option is not available here.' };
  }

  const base = `/mock-provider/checkout-sessions/${encodeURIComponent(sessionId)}`;
  let returnTo: string;
  try {
    const session = await apiServer(base, { schema: mockCheckoutSessionSchema });
    if (session.status !== 'PENDING') {
      return { formError: 'This payment has already been settled.' };
    }
    if (outcome === 'fail') {
      await apiServer(`${base}/fail`, { method: 'POST' });
      returnTo = billingReturnUrl(session.workspaceId, { declined: true });
    } else {
      const { eventId } = await apiServer(`${base}/complete`, {
        method: 'POST',
        schema: eventIssuedSchema,
      });
      if (outcome === 'pay_and_redeliver') {
        await apiServer(`/mock-provider/events/${encodeURIComponent(eventId)}/redeliver`, {
          method: 'POST',
        });
      }
      returnTo = billingReturnUrl(session.workspaceId, { awaiting: session.plan });
    }
  } catch (error) {
    return failureState(error);
  }
  redirect(returnTo);
}
