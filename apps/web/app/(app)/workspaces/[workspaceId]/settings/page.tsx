import { roleAtLeast } from '@collab-docs/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { UsageMeter } from '@/components/billing/usage-meter';
import { EmptyState, ForbiddenState } from '@/components/states';
import { PLAN_LABELS } from '@/lib/billing/format';
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

export const metadata: Metadata = { title: 'Settings' };

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

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const workspace = await requireWorkspace(workspaceId);
  // the nav hides this page from editors and viewers; opening the URL directly lands here
  if (!roleAtLeast(workspace.role, 'ADMIN')) {
    return (
      <ForbiddenState description="Only workspace admins and owners can change these settings." />
    );
  }
  const [user, members, invites, usage] = await Promise.all([
    getCurrentUser(),
    getMembers(workspaceId),
    getInvites(workspaceId),
    getUsage(workspaceId),
  ]);
  const slots = usage.members.current + usage.members.pendingInvites;

  return (
    <div className="grid gap-6">
      <Section id="rename-heading" title="General">
        <RenameWorkspaceForm workspaceId={workspaceId} name={workspace.name} />
      </Section>
      <Section id="usage-heading" title="Plan and usage">
        <p className="text-sm text-muted-foreground">
          This workspace is on the {PLAN_LABELS[usage.plan]} plan.{' '}
          <Link
            href={`/workspaces/${workspaceId}/billing`}
            className="text-primary underline underline-offset-4 hover:no-underline"
          >
            Manage billing
          </Link>
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <UsageMeter kind="members" current={slots} limit={usage.members.limit} />
          <UsageMeter
            kind="documents"
            current={usage.documents.current}
            limit={usage.documents.limit}
          />
          <UsageMeter
            kind="storage"
            current={usage.storage.currentBytes}
            limit={usage.storage.limitBytes}
          />
        </div>
      </Section>
      <Section id="members-heading" title="Members">
        {members.length === 0 ? (
          <EmptyState title="No members" />
        ) : (
          <MembersTable
            workspaceId={workspaceId}
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
        {/* a new key when the slots change: a refusal for lack of a slot must not outlive the slot that was freed */}
        <InviteForm key={slots} workspaceId={workspaceId} />
      </Section>
      <Section id="pending-heading" title="Pending invitations">
        <PendingInvites workspaceId={workspaceId} invites={invites} />
      </Section>
    </div>
  );
}
