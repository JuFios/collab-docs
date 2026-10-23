'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form';
import { acceptInviteAction } from '@/lib/workspaces/actions';
import { useActionFeedback } from './use-action-feedback';

/** Client component: `useActionState` for the pending state and the error the api returns for this invite. */
export function AcceptInviteForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(acceptInviteAction, {});
  useActionFeedback(state);
  return (
    <form action={formAction} className="grid gap-4">
      <FormError message={state.formError} />
      <input type="hidden" name="token" value={token} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Joining…' : 'Accept invitation'}
      </Button>
    </form>
  );
}
