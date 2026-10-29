'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError, FormField } from '@/components/ui/form';
import { renameWorkspaceAction } from '@/lib/workspaces/actions';
import { useActionFeedback } from './use-action-feedback';

/**
 * Client component for the pending state and the field errors. The form posts to the Server Action itself, so it
 * also works without JavaScript; the action validates with the shared zod schema.
 */
export function RenameWorkspaceForm({ workspaceId, name }: { workspaceId: string; name: string }) {
  const [state, formAction, pending] = useActionState(renameWorkspaceAction, {});
  useActionFeedback(state);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate className="grid max-w-md gap-4">
      <FormError message={state.formError} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <FormField
        name="name"
        label="Workspace name"
        autoComplete="off"
        defaultValue={state.values?.name ?? name}
        errors={errors.name}
        required
      />
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}
