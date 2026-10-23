// @vitest-environment jsdom
import type { Invite, Member, WorkspaceRole } from '@collab-docs/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onPlanLimitExceeded } from '@/lib/api/plan-limit-events';

const actions = vi.hoisted(() => ({
  createWorkspaceAction: vi.fn(async () => ({})),
  renameWorkspaceAction: vi.fn(async () => ({})),
  inviteMemberAction: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  changeMemberRoleAction: vi.fn(async () => ({ ok: true as const, notice: 'Role updated.' })),
  removeMemberAction: vi.fn(async () => ({ ok: true as const, notice: 'Member removed.' })),
  revokeInviteAction: vi.fn(async () => ({ ok: true as const, notice: 'Invitation revoked.' })),
  acceptInviteAction: vi.fn(async () => ({})),
}));
vi.mock('@/lib/workspaces/actions', () => actions);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const navigation = vi.hoisted(() => ({ pathname: '/w/abc', refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ refresh: navigation.refresh, push: navigation.push }),
}));

import { CreateWorkspaceForm } from './create-workspace-form';
import { InviteForm } from './invite-form';
import { LeaveWorkspaceButton } from './leave-workspace-button';
import { MembersTable } from './members-table';
import { PendingInvites } from './pending-invites';
import { RenameWorkspaceForm } from './rename-workspace-form';
import { WorkspaceNav } from './workspace-nav';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  navigation.pathname = '/w/abc';
});

const WS = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const member = (id: string, name: string, role: WorkspaceRole): Member => ({
  userId: `0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a${id}`,
  name,
  email: `${name.toLowerCase()}@example.com`,
  role,
  joinedAt: '2026-10-01T00:00:00Z',
});
const team = [
  member('01', 'Olga', 'OWNER'),
  member('02', 'Adam', 'ADMIN'),
  member('03', 'Eve', 'EDITOR'),
  member('04', 'Vic', 'VIEWER'),
];

describe('CreateWorkspaceForm', () => {
  it('validates the name before calling the action', async () => {
    const user = userEvent.setup();
    render(<CreateWorkspaceForm />);
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('Enter a workspace name.')).toBeInTheDocument();
    expect(actions.createWorkspaceAction).not.toHaveBeenCalled();
  });

  it('submits a valid name and opens the new workspace', async () => {
    actions.createWorkspaceAction.mockResolvedValueOnce({
      ok: true,
      notice: 'Workspace created.',
      redirectTo: '/w/new-id',
    } as never);
    const user = userEvent.setup();
    render(<CreateWorkspaceForm />);
    await user.type(screen.getByLabelText('Workspace name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(actions.createWorkspaceAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/w/new-id'));
    expect(navigation.refresh).toHaveBeenCalled();
  });
});

describe('RenameWorkspaceForm', () => {
  it('starts with the current name and rejects an over-long one', async () => {
    const user = userEvent.setup();
    render(<RenameWorkspaceForm workspaceId={WS} name="Acme" />);
    const input = screen.getByLabelText('Workspace name');
    expect(input).toHaveValue('Acme');
    await user.clear(input);
    await user.type(input, 'x'.repeat(81));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Use at most 80 characters.')).toBeInTheDocument();
    expect(actions.renameWorkspaceAction).not.toHaveBeenCalled();
  });
});

describe('InviteForm', () => {
  it('requires a valid email and offers no OWNER role', async () => {
    const user = userEvent.setup();
    render(<InviteForm workspaceId={WS} />);
    const options = within(screen.getByLabelText('Role')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Admin', 'Editor', 'Viewer']);
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(actions.inviteMemberAction).not.toHaveBeenCalled();
  });

  it('sends the chosen email and role', async () => {
    const user = userEvent.setup();
    render(<InviteForm workspaceId={WS} />);
    await user.type(screen.getByLabelText('Email'), 'grace@example.com');
    await user.selectOptions(screen.getByLabelText('Role'), 'VIEWER');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(actions.inviteMemberAction).toHaveBeenCalledTimes(1));
    const data = (actions.inviteMemberAction.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(data.get('email')).toBe('grace@example.com');
    expect(data.get('role')).toBe('VIEWER');
    expect(data.get('workspaceId')).toBe(WS);
  });

  it('shows the plan-limit explanation and notifies the upgrade dialog', async () => {
    const listener = vi.fn();
    const off = onPlanLimitExceeded(listener);
    const details = { kind: 'members', limit: 3, current: 3, plan: 'FREE' };
    actions.inviteMemberAction.mockResolvedValueOnce({
      formError: 'The Free plan allows 3 members and all of them are in use.',
      planLimit: { message: 'The Free plan allows 3 members and all of them are in use.', details },
      values: { email: 'grace@example.com', role: 'EDITOR' },
    });
    const user = userEvent.setup();
    render(<InviteForm workspaceId={WS} />);
    await user.type(screen.getByLabelText('Email'), 'grace@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The Free plan allows 3 members');
    expect(screen.getByLabelText('Email')).toHaveValue('grace@example.com');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ details }));
    off();
  });

  it('puts a conflict on the email field', async () => {
    actions.inviteMemberAction.mockResolvedValueOnce({
      fieldErrors: { email: ['Already a member'] },
      values: { email: 'eve@example.com', role: 'EDITOR' },
    });
    const user = userEvent.setup();
    render(<InviteForm workspaceId={WS} />);
    await user.type(screen.getByLabelText('Email'), 'eve@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Already a member')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('toasts and clears the form after a successful invite', async () => {
    actions.inviteMemberAction.mockResolvedValueOnce({ ok: true, notice: 'Invitation sent.' });
    const user = userEvent.setup();
    render(<InviteForm workspaceId={WS} />);
    await user.type(screen.getByLabelText('Email'), 'grace@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Invitation sent.'));
    // the settings page is re-fetched so the pending list shows the new invitation
    expect(navigation.refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveValue(''));
  });
});

describe('MembersTable by role', () => {
  const render$ = (actorRole: WorkspaceRole, currentUserId: string) =>
    render(
      <MembersTable
        workspaceId={WS}
        members={team}
        currentUserId={currentUserId}
        actorRole={actorRole}
      />,
    );

  it('lets an owner change every other role, including granting OWNER', () => {
    render$('OWNER', team[0]!.userId);
    const select = screen.getByLabelText('Role of Eve');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Owner', 'Admin', 'Editor', 'Viewer']);
    expect(screen.getByRole('button', { name: 'Remove Eve' })).toBeInTheDocument();
    // the only owner can neither be demoted nor removed
    expect(screen.queryByLabelText('Role of Olga')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Olga' })).not.toBeInTheDocument();
  });

  it('keeps an admin away from the owner row and from granting OWNER', () => {
    render$('ADMIN', team[1]!.userId);
    expect(screen.queryByLabelText('Role of Olga')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Olga' })).not.toBeInTheDocument();
    const options = within(screen.getByLabelText('Role of Eve')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Admin', 'Editor', 'Viewer']);
    // no "remove" on your own row
    expect(screen.queryByRole('button', { name: 'Remove Adam' })).not.toBeInTheDocument();
    expect(screen.getByText('(you)')).toBeInTheDocument();
  });

  it('changes a role through the action and reports the result', async () => {
    const user = userEvent.setup();
    render$('OWNER', team[0]!.userId);
    await user.selectOptions(screen.getByLabelText('Role of Eve'), 'VIEWER');
    await waitFor(() =>
      expect(actions.changeMemberRoleAction).toHaveBeenCalledWith({
        workspaceId: WS,
        userId: team[2]!.userId,
        role: 'VIEWER',
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Role updated.'));
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it('asks for confirmation before removing, and shows the failure reason', async () => {
    actions.removeMemberAction.mockResolvedValueOnce({ formError: 'Cannot remove' } as never);
    const user = userEvent.setup();
    render$('OWNER', team[0]!.userId);
    await user.click(screen.getByRole('button', { name: 'Remove Vic' }));
    expect(actions.removeMemberAction).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Remove member' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cannot remove'));
    expect(navigation.refresh).not.toHaveBeenCalled();
  });
});

describe('PendingInvites', () => {
  const invite: Invite = {
    id: '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a99',
    email: 'grace@example.com',
    role: 'EDITOR',
    expiresAt: '2026-10-30T00:00:00Z',
    createdAt: '2026-10-23T00:00:00Z',
    invitedBy: '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01',
  };

  it('shows an empty state', () => {
    render(<PendingInvites workspaceId={WS} invites={[]} />);
    expect(screen.getByText('No pending invitations')).toBeInTheDocument();
  });

  it('revokes an invitation', async () => {
    const user = userEvent.setup();
    render(<PendingInvites workspaceId={WS} invites={[invite]} />);
    expect(screen.getByText('grace@example.com')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Revoke invitation for grace@example.com' }),
    );
    await waitFor(() =>
      expect(actions.revokeInviteAction).toHaveBeenCalledWith({
        workspaceId: WS,
        inviteId: invite.id,
      }),
    );
    await waitFor(() => expect(navigation.refresh).toHaveBeenCalled());
  });
});

describe('LeaveWorkspaceButton', () => {
  const userId = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a77';
  const renderButton = () =>
    render(<LeaveWorkspaceButton workspaceId={WS} workspaceName="Acme" userId={userId} />);

  it('asks for confirmation, leaves, and goes back to the workspace list', async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: 'Leave workspace' }));
    expect(actions.removeMemberAction).not.toHaveBeenCalled();
    expect(await screen.findByText('Leave Acme?')).toBeInTheDocument();

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Leave workspace' }));
    await waitFor(() =>
      expect(actions.removeMemberAction).toHaveBeenCalledWith({ workspaceId: WS, userId }),
    );
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/w?all=1'));
    expect(navigation.refresh).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('You left Acme.');
  });

  it('shows why the last owner cannot leave and stays on the page', async () => {
    actions.removeMemberAction.mockResolvedValueOnce({
      formError: 'A workspace must keep at least one owner',
    } as never);
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: 'Leave workspace' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Leave workspace' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'A workspace must keep at least one owner',
    );
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('can be cancelled without calling the api', async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: 'Leave workspace' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(actions.removeMemberAction).not.toHaveBeenCalled();
  });
});

describe('WorkspaceNav', () => {
  it('hides Settings from editors and viewers', () => {
    render(<WorkspaceNav workspaceId="abc" canManage={false} />);
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('shows Settings to admins and marks it when active', () => {
    navigation.pathname = '/w/abc/settings';
    render(<WorkspaceNav workspaceId="abc" canManage />);
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });
});
