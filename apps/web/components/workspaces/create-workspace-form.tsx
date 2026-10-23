'use client';

import { createWorkspaceInputSchema } from '@collab-docs/shared';
import { Button } from '@/components/ui/button';
import { FormError, FormField } from '@/components/ui/form';
import { createWorkspaceAction } from '@/lib/workspaces/actions';
import { useActionFeedback } from './use-action-feedback';
import { useValidatedAction } from './use-validated-action';

/** Client component: pending state and field errors, with the zod check done before the round trip. */
export function CreateWorkspaceForm() {
  const [state, formAction, pending] = useValidatedAction(
    createWorkspaceAction,
    createWorkspaceInputSchema,
  );
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
