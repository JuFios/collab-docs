import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';

const { apiServer, revalidatePath, redirect } = vi.hoisted(() => ({
  apiServer: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock('@/lib/api/server', () => ({ apiServer }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({ redirect }));

import {
  acceptInviteAction,
  changeMemberRoleAction,
  createWorkspaceAction,
  inviteMemberAction,
  removeMemberAction,
  renameWorkspaceAction,
  revokeInviteAction,
} from './actions';

const WS = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const USER = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiServer.mockResolvedValue(undefined);
});

describe('inviteMemberAction', () => {
  const valid = { workspaceId: WS, email: ' Grace@Example.com ', role: 'EDITOR' };

  it('validates before calling the api', async () => {
    const state = await inviteMemberAction({}, form({ ...valid, email: 'nope' }));
    expect(state.fieldErrors?.email).toEqual(['Enter a valid email address.']);
    expect(state.values?.email).toBe('nope');
    expect(apiServer).not.toHaveBeenCalled();
  });

  it('sends the normalised invite; the page refresh is left to the caller', async () => {
    const state = await inviteMemberAction({}, form(valid));
    expect(apiServer).toHaveBeenCalledWith(`/workspaces/${WS}/invites`, {
      method: 'POST',
      body: { email: 'grace@example.com', role: 'EDITOR' },
    });
    // revalidating here would make the response carry the re-rendered page (see useActionFeedback)
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(state).toEqual({ ok: true, notice: 'Invitation sent to grace@example.com.' });
  });

  it('explains a plan limit instead of showing the raw error', async () => {
    apiServer.mockRejectedValue(
      new ApiError(403, 'PLAN_LIMIT_EXCEEDED', 'raw', 'c-1', {
        kind: 'members',
        limit: 3,
        current: 3,
        plan: 'FREE',
      }),
    );
    const state = await inviteMemberAction({}, form(valid));
    expect(state.formError).toContain('The Free plan allows 3 members');
    expect(state.planLimit?.details).toMatchObject({ kind: 'members', limit: 3 });
    expect(state.values).toEqual({ email: ' Grace@Example.com ', role: 'EDITOR' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('puts "already a member" on the email field', async () => {
    apiServer.mockRejectedValue(new ApiError(409, 'CONFLICT', 'Already a member', 'c'));
    const state = await inviteMemberAction({}, form(valid));
    expect(state.fieldErrors).toEqual({ email: ['Already a member'] });
  });

  it('refuses a workspace id that is not a uuid', async () => {
    const state = await inviteMemberAction({}, form({ ...valid, workspaceId: '../x' }));
    expect(state.formError).toBe('Unknown workspace.');
    expect(apiServer).not.toHaveBeenCalled();
  });
});

describe('createWorkspaceAction', () => {
  it('rejects an empty name', async () => {
    const state = await createWorkspaceAction({}, form({ name: '   ' }));
    expect(state.fieldErrors?.name).toEqual(['Enter a workspace name.']);
  });

  it('creates the workspace and tells the client where to go', async () => {
    apiServer.mockResolvedValue({
      id: WS,
      name: 'Acme',
      slug: 'acme',
      role: 'OWNER',
      plan: 'FREE',
      createdAt: '2026-10-23T00:00:00Z',
    });
    const state = await createWorkspaceAction({}, form({ name: ' Acme ' }));
    expect(state).toEqual({ ok: true, notice: 'Workspace created.', redirectTo: `/w/${WS}` });
    // navigation and refresh are the caller's job: a server-side redirect/revalidate stalled the form
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(apiServer).toHaveBeenCalledWith(
      '/workspaces',
      expect.objectContaining({ method: 'POST', body: { name: 'Acme' } }),
    );
  });

  it('shows api validation messages on the field', async () => {
    apiServer.mockRejectedValue(
      new ApiError(400, 'VALIDATION_FAILED', 'bad', 'c', [
        { field: 'name', messages: ['too long'] },
      ]),
    );
    const state = await createWorkspaceAction({}, form({ name: 'Acme' }));
    expect(state.fieldErrors).toEqual({ name: ['too long'] });
    expect(state.values).toEqual({ name: 'Acme' });
  });
});

describe('renameWorkspaceAction', () => {
  it('renames and keeps the new name in the form', async () => {
    const state = await renameWorkspaceAction({}, form({ workspaceId: WS, name: ' New ' }));
    expect(apiServer).toHaveBeenCalledWith(
      `/workspaces/${WS}`,
      expect.objectContaining({ method: 'PATCH', body: { name: 'New' } }),
    );
    expect(state).toEqual({ ok: true, notice: 'Workspace renamed.', values: { name: 'New' } });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('reports a missing permission with the server message', async () => {
    apiServer.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'You do not have permission', 'c'));
    const state = await renameWorkspaceAction({}, form({ workspaceId: WS, name: 'New' }));
    expect(state.formError).toBe('You do not have permission');
  });
});

describe('member and invite actions', () => {
  it('changes a role through the members endpoint', async () => {
    const result = await changeMemberRoleAction({ workspaceId: WS, userId: USER, role: 'VIEWER' });
    expect(apiServer).toHaveBeenCalledWith(`/workspaces/${WS}/members/${USER}`, {
      method: 'PATCH',
      body: { role: 'VIEWER' },
    });
    expect(result.ok).toBe(true);
  });

  it('validates the arguments of non-form actions', async () => {
    expect(await changeMemberRoleAction({ workspaceId: WS, userId: USER, role: 'ROOT' })).toEqual({
      formError: 'Invalid request.',
    });
    expect(await removeMemberAction({ workspaceId: WS, userId: '../..' })).toEqual({
      formError: 'Invalid request.',
    });
    expect(await revokeInviteAction({ workspaceId: 'x', inviteId: USER })).toEqual({
      formError: 'Invalid request.',
    });
    expect(apiServer).not.toHaveBeenCalled();
  });

  it('surfaces the last-owner rule from the api', async () => {
    apiServer.mockRejectedValue(new ApiError(409, 'CONFLICT', 'The last owner cannot leave', 'c'));
    const result = await removeMemberAction({ workspaceId: WS, userId: USER });
    expect(result).toEqual({ formError: 'The last owner cannot leave' });
  });

  it('revokes an invite', async () => {
    const result = await revokeInviteAction({ workspaceId: WS, inviteId: USER });
    expect(apiServer).toHaveBeenCalledWith(`/workspaces/${WS}/invites/${USER}`, {
      method: 'DELETE',
    });
    expect(result).toEqual({ ok: true, notice: 'Invitation revoked.' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('acceptInviteAction', () => {
  it('joins and tells the client to open the workspace', async () => {
    apiServer.mockResolvedValue({ workspaceId: WS, role: 'EDITOR' });
    const state = await acceptInviteAction({}, form({ token: 'tok_123' }));
    expect(state).toEqual({
      ok: true,
      notice: 'You joined the workspace.',
      redirectTo: `/w/${WS}`,
    });
    expect(apiServer).toHaveBeenCalledWith(
      '/invites/tok_123/accept',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows why the invite cannot be accepted', async () => {
    apiServer.mockRejectedValue(
      new ApiError(403, 'FORBIDDEN', 'This invitation was sent to a different email address', 'c'),
    );
    const state = await acceptInviteAction({}, form({ token: 'tok_123' }));
    expect(state.formError).toBe('This invitation was sent to a different email address');
  });

  it('explains a plan limit hit while joining', async () => {
    apiServer.mockRejectedValue(
      new ApiError(403, 'PLAN_LIMIT_EXCEEDED', 'raw', 'c', {
        kind: 'members',
        limit: 3,
        current: 3,
        plan: 'FREE',
      }),
    );
    const state = await acceptInviteAction({}, form({ token: 'tok_123' }));
    expect(state.formError).toContain('Free plan allows 3 members');
  });
});
