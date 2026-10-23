'use server';

import {
  acceptInviteSchema,
  createWorkspaceInputSchema,
  inviteInputSchema,
  renameWorkspaceInputSchema,
  workspaceRoleSchema,
  workspaceSchema,
} from '@collab-docs/shared';
import { z } from 'zod';
import { isApiError } from '@/lib/api/errors';
import { apiServer } from '@/lib/api/server';
import { fieldErrorsFromZod, textField } from '@/lib/auth/form-state';
import { type ActionState, failureState } from './action-state';

// Actions return data and never call `revalidatePath`/`redirect`: the calling component refreshes the route with
// `router.refresh()` (and navigates to `redirectTo`) once the action has resolved, see `useActionFeedback`.
const idSchema = z.string().uuid();

function segment(id: string): string {
  return encodeURIComponent(id);
}

export async function createWorkspaceAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: textField(formData, 'name') };
  const parsed = createWorkspaceInputSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrorsFromZod(parsed.error), values };

  let workspaceId: string;
  try {
    const created = await apiServer('/workspaces', {
      method: 'POST',
      body: parsed.data,
      schema: workspaceSchema,
    });
    workspaceId = created.id;
  } catch (error) {
    return failureState(error, values);
  }
  return { ok: true, notice: 'Workspace created.', redirectTo: `/w/${workspaceId}` };
}

export async function renameWorkspaceAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: textField(formData, 'name') };
  const workspaceId = idSchema.safeParse(textField(formData, 'workspaceId'));
  if (!workspaceId.success) return { formError: 'Unknown workspace.', values };
  const parsed = renameWorkspaceInputSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrorsFromZod(parsed.error), values };

  try {
    await apiServer(`/workspaces/${segment(workspaceId.data)}`, {
      method: 'PATCH',
      body: parsed.data,
      schema: workspaceSchema,
    });
  } catch (error) {
    return failureState(error, values);
  }
  return { ok: true, notice: 'Workspace renamed.', values: { name: parsed.data.name } };
}

export async function inviteMemberAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { email: textField(formData, 'email'), role: textField(formData, 'role') };
  const workspaceId = idSchema.safeParse(textField(formData, 'workspaceId'));
  if (!workspaceId.success) return { formError: 'Unknown workspace.', values };
  const parsed = inviteInputSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrorsFromZod(parsed.error), values };

  try {
    await apiServer(`/workspaces/${segment(workspaceId.data)}/invites`, {
      method: 'POST',
      body: parsed.data,
    });
  } catch (error) {
    // an address that already belongs to the workspace is a problem with the email field, not with the form
    if (isApiError(error) && error.code === 'CONFLICT') {
      return { values, fieldErrors: { email: [error.message] } };
    }
    return failureState(error, values);
  }
  return { ok: true, notice: `Invitation sent to ${parsed.data.email}.` };
}

const changeRoleSchema = z.object({
  workspaceId: idSchema,
  userId: idSchema,
  role: workspaceRoleSchema,
});

/** Called from an event handler (not a `<form>`), so the arguments are validated like any untrusted input. */
export async function changeMemberRoleAction(input: {
  workspaceId: string;
  userId: string;
  role: string;
}): Promise<ActionState> {
  const parsed = changeRoleSchema.safeParse(input);
  if (!parsed.success) return { formError: 'Invalid request.' };
  try {
    await apiServer(
      `/workspaces/${segment(parsed.data.workspaceId)}/members/${segment(parsed.data.userId)}`,
      { method: 'PATCH', body: { role: parsed.data.role } },
    );
  } catch (error) {
    return failureState(error);
  }
  return { ok: true, notice: 'Role updated.' };
}

const memberRefSchema = z.object({ workspaceId: idSchema, userId: idSchema });

export async function removeMemberAction(input: {
  workspaceId: string;
  userId: string;
}): Promise<ActionState> {
  const parsed = memberRefSchema.safeParse(input);
  if (!parsed.success) return { formError: 'Invalid request.' };
  try {
    await apiServer(
      `/workspaces/${segment(parsed.data.workspaceId)}/members/${segment(parsed.data.userId)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    return failureState(error);
  }
  return { ok: true, notice: 'Member removed.' };
}

const inviteRefSchema = z.object({ workspaceId: idSchema, inviteId: idSchema });

export async function revokeInviteAction(input: {
  workspaceId: string;
  inviteId: string;
}): Promise<ActionState> {
  const parsed = inviteRefSchema.safeParse(input);
  if (!parsed.success) return { formError: 'Invalid request.' };
  try {
    await apiServer(
      `/workspaces/${segment(parsed.data.workspaceId)}/invites/${segment(parsed.data.inviteId)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    return failureState(error);
  }
  return { ok: true, notice: 'Invitation revoked.' };
}

export async function acceptInviteAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const token = textField(formData, 'token');
  if (!token) return { formError: 'This invitation link is not valid.' };
  let workspaceId: string;
  try {
    const joined = await apiServer(`/invites/${segment(token)}/accept`, {
      method: 'POST',
      schema: acceptInviteSchema,
    });
    workspaceId = joined.workspaceId;
  } catch (error) {
    return failureState(error);
  }
  return { ok: true, notice: 'You joined the workspace.', redirectTo: `/w/${workspaceId}` };
}
