'use client';

import { useActionState } from 'react';
import { INVITABLE_ROLES, type WorkspaceRole } from '@collab-docs/shared';
import { Button } from '@/components/ui/button';
import { FormError, FormField } from '@/components/ui/form';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ROLE_LABELS } from '@/lib/workspaces/labels';
import { inviteMemberAction } from '@/lib/workspaces/actions';
import { useActionFeedback } from './use-action-feedback';

/** Client component: pending state, field errors and the plan-limit explanation from the Server Action. */
export function InviteForm({
  workspaceId,
  roles = INVITABLE_ROLES,
}: {
  workspaceId: string;
  roles?: readonly WorkspaceRole[];
}) {
  const [state, formAction, pending] = useActionState(inviteMemberAction, {});
  // React resets an uncontrolled form after a successful action; `values` is only echoed on failure
  useActionFeedback(state);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate className="grid max-w-xl gap-4">
      <FormError message={state.formError} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <FormField
          name="email"
          label="Email"
          type="email"
          autoComplete="off"
          defaultValue={state.values?.email}
          errors={errors.email}
          required
        />
        <div className="grid gap-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <Select
            id="invite-role"
            name="role"
            defaultValue={state.values?.role || 'EDITOR'}
            aria-invalid={Boolean(errors.role?.length)}
          >
            {roles.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </Select>
          {errors.role?.length ? (
            <p role="alert" className="text-xs text-destructive">
              {errors.role.join(' ')}
            </p>
          ) : null}
        </div>
      </div>
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? 'Sending…' : 'Send invitation'}
      </Button>
    </form>
  );
}
