'use client';

import type { Invite } from '@collab-docs/shared';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { revokeInviteAction } from '@/lib/workspaces/actions';
import { formatDate, ROLE_LABELS } from '@/lib/workspaces/labels';

/** Client component: revoking calls a Server Action from an event handler and shows a pending state. */
export function PendingInvites({
  workspaceId,
  invites,
}: {
  workspaceId: string;
  invites: readonly Invite[];
}) {
  if (invites.length === 0) {
    return (
      <EmptyState
        title="No pending invitations"
        description="Invitations you send show up here until they are accepted."
      />
    );
  }
  return (
    <ul className="divide-y rounded-md border" aria-label="Pending invitations">
      {invites.map((invite) => (
        <InviteRow key={invite.id} workspaceId={workspaceId} invite={invite} />
      ))}
    </ul>
  );
}

function InviteRow({ workspaceId, invite }: { workspaceId: string; invite: Invite }) {
  const [pending, startTransition] = useTransition();

  function revoke() {
    startTransition(async () => {
      const result = await revokeInviteAction({ workspaceId, inviteId: invite.id });
      if (result.ok) {
        toast.success(result.notice ?? 'Invitation revoked.');
      } else toast.error(result.formError ?? 'Could not revoke the invitation.');
    });
  }

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <div>
        <div className="font-medium">{invite.email}</div>
        <div className="text-xs text-muted-foreground">
          {ROLE_LABELS[invite.role]} · expires {formatDate(invite.expiresAt)}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={revoke}
        aria-label={`Revoke invitation for ${invite.email}`}
      >
        {pending ? 'Revoking…' : 'Revoke'}
      </Button>
    </li>
  );
}
