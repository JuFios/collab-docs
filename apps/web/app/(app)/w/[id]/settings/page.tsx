import { roleAtLeast } from '@collab-docs/shared';
import type { Metadata } from 'next';
import { EmptyState, ForbiddenState } from '@/components/states';
import { InviteForm } from '@/components/workspaces/invite-form';
import { MembersTable } from '@/components/workspaces/members-table';
import { PendingInvites } from '@/components/workspaces/pending-invites';
import { RenameWorkspaceForm } from '@/components/workspaces/rename-workspace-form';
import {
  getCurrentUser,
  getInvites,
  getMembers,
  getUsage,
  requireWorkspace,
} from '@/lib/workspaces/data';

export const metadata: Metadata = { title: 'Settings · Collab Docs' };

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-3 rounded-lg border bg-card p-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await requireWorkspace(id);
  // the nav hides this page from editors and viewers; opening the URL directly lands here
  if (!roleAtLeast(workspace.role, 'ADMIN')) {
    return (
      <ForbiddenState description="Only workspace admins and owners can change these settings." />
    );
  }
  const [user, members, invites, usage] = await Promise.all([
    getCurrentUser(),
    getMembers(id),
    getInvites(id),
    getUsage(id),
  ]);
  const slots = usage.members.current + usage.members.pendingInvites;

  return (
    <div className="grid gap-6">
      <Section id="rename-heading" title="General">
        <RenameWorkspaceForm workspaceId={id} name={workspace.name} />
      </Section>
      <Section id="members-heading" title="Members">
        {members.length === 0 ? (
          <EmptyState title="No members" />
        ) : (
          <MembersTable
            workspaceId={id}
            members={members}
            currentUserId={user.id}
            actorRole={workspace.role}
          />
        )}
      </Section>
      <Section id="invite-heading" title="Invite people">
        <p className="text-sm text-muted-foreground">
          {slots} of {usage.members.limit} member slots used, pending invitations included.
        </p>
        <InviteForm workspaceId={id} />
      </Section>
      <Section id="pending-heading" title="Pending invitations">
        <PendingInvites workspaceId={id} invites={invites} />
      </Section>
    </div>
  );
}
