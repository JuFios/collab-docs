'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError, FormField } from '@/components/ui/form';
import { createWorkspaceAction } from '@/lib/workspaces/actions';
import { useActionFeedback } from './use-action-feedback';

/**
 * Client component for the pending state and the field errors. The form posts to the Server Action itself, so it
 * also works without JavaScript; the action validates with the shared zod schema.
 */
export function CreateWorkspaceForm() {
  const [state, formAction, pending] = useActionState(createWorkspaceAction, {});
  useActionFeedback(state);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate className="grid gap-4">
      <FormError message={state.formError} />
      <FormField
        name="name"
        label="Workspace name"
        placeholder="Acme"
        autoComplete="off"
        defaultValue={state.values?.name}
        errors={errors.name}
        required
      />
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? 'Creating…' : 'Create workspace'}
      </Button>
    </form>
  );
}
