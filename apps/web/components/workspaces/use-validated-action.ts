'use client';

import { useActionState } from 'react';
import { fieldErrorsFromZod } from '@/lib/auth/form-state';
import type { ActionState } from '@/lib/workspaces/action-state';

type Schema = {
  safeParse(
    input: unknown,
  ): { success: true } | { success: false; error: Parameters<typeof fieldErrorsFromZod>[0] };
};

function textValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) if (typeof value === 'string') values[key] = value;
  return values;
}

/**
 * `useActionState` that runs the zod schema in the browser first and only calls the Server Action when the
 * input is valid, so the user gets field errors without a round trip. Validation lives inside the action instead
 * of an `onSubmit` handler: a submit handler next to a function `action` raced the router update and left the
 * form stuck in its pending state.
 */
export function useValidatedAction(
  action: (previous: ActionState, formData: FormData) => Promise<ActionState>,
  schema: Schema,
) {
  return useActionState(async (previous: ActionState, formData: FormData): Promise<ActionState> => {
    const values = textValues(formData);
    const parsed = schema.safeParse(values);
    if (!parsed.success) return { fieldErrors: fieldErrorsFromZod(parsed.error), values };
    return action(previous, formData);
  }, {});
}
