'use client';

import { renameWorkspaceInputSchema } from '@collab-docs/shared';
import { Button } from '@/components/ui/button';
import { FormError, FormField } from '@/components/ui/form';
import { renameWorkspaceAction } from '@/lib/workspaces/actions';
import { useActionFeedback } from './use-action-feedback';
import { useValidatedAction } from './use-validated-action';

/** Client component: pending state and field errors, with the zod check done before the round trip. */
export function RenameWorkspaceForm({ workspaceId, name }: { workspaceId: string; name: string }) {
  const [state, formAction, pending] = useValidatedAction(
    renameWorkspaceAction,
    renameWorkspaceInputSchema,
  );
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
