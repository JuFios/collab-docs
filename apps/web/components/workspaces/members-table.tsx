'use client';

import {
  type Member,
  WORKSPACE_ROLES,
  type WorkspaceRole,
  checkMemberRemoval,
  checkRoleChange,
} from '@collab-docs/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { changeMemberRoleAction, removeMemberAction } from '@/lib/workspaces/actions';
import { formatDate, ROLE_LABELS } from '@/lib/workspaces/labels';

interface Props {
  workspaceId: string;
  members: readonly Member[];
  currentUserId: string;
  actorRole: WorkspaceRole;
}

/** Client component: role selects and the remove confirmation call Server Actions from event handlers. */
export function MembersTable({ workspaceId, members, currentUserId, actorRole }: Props) {
  const owners = members.filter((member) => member.role === 'OWNER').length;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <caption className="sr-only">Workspace members</caption>
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Member
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Role
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Joined
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <MemberRow
              key={member.userId}
              workspaceId={workspaceId}
              member={member}
              actorRole={actorRole}
              isSelf={member.userId === currentUserId}
              isLastOwner={member.role === 'OWNER' && owners === 1}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberRow({
  workspaceId,
  member,
  actorRole,
  isSelf,
  isLastOwner,
}: {
  workspaceId: string;
  member: Member;
  actorRole: WorkspaceRole;
  isSelf: boolean;
  isLastOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  const allowedRoles = WORKSPACE_ROLES.filter(
    (role) =>
      role === member.role ||
      checkRoleChange({
        actorRole,
        targetRole: member.role,
        newRole: role,
        targetIsLastOwner: isLastOwner,
      }) === null,
  );
  const canChangeRole = allowedRoles.length > 1;
  const canRemove =
    !isSelf &&
    checkMemberRemoval({
      actorRole,
      targetRole: member.role,
      self: false,
      targetIsLastOwner: isLastOwner,
    }) === null;

  function changeRole(role: string) {
    startTransition(async () => {
      const result = await changeMemberRoleAction({ workspaceId, userId: member.userId, role });
      if (result.ok) {
        toast.success(result.notice ?? 'Role updated.');
        router.refresh();
      } else toast.error(result.formError ?? 'Could not change the role.');
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await removeMemberAction({ workspaceId, userId: member.userId });
      if (result.ok) {
        toast.success(result.notice ?? 'Member removed.');
        router.refresh();
      } else toast.error(result.formError ?? 'Could not remove the member.');
      setConfirming(false);
    });
  }

  return (
    <tr className="border-t">
      <td className="px-3 py-2">
        <div className="font-medium">
          {member.name}
          {isSelf ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
        </div>
        <div className="text-xs text-muted-foreground">{member.email}</div>
      </td>
      <td className="px-3 py-2">
        {canChangeRole ? (
          <Select
            aria-label={`Role of ${member.name}`}
            className="w-32"
            value={member.role}
            disabled={pending}
            onChange={(event) => changeRole(event.target.value)}
          >
            {allowedRoles.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </Select>
        ) : (
          <span>{ROLE_LABELS[member.role]}</span>
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground">{formatDate(member.joinedAt)}</td>
      <td className="px-3 py-2 text-right">
        {canRemove ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setConfirming(true)}
              aria-label={`Remove ${member.name}`}
            >
              Remove
            </Button>
            <Dialog open={confirming} onOpenChange={setConfirming}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Remove {member.name}?</DialogTitle>
                  <DialogDescription>
                    They lose access to this workspace and everything shared through it. You can
                    invite them again later.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                  <Button variant="destructive" disabled={pending} onClick={remove}>
                    {pending ? 'Removing…' : 'Remove member'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : null}
      </td>
    </tr>
  );
}
