import type { Metadata } from 'next';
import Link from 'next/link';
import { roleAtLeast } from '@collab-docs/shared';
import {
  MembersBlock,
  RecentDocumentsBlock,
  SharedWithMeBlock,
  UsageBlock,
} from '@/components/dashboard/blocks';
import { DashboardBlock } from '@/components/dashboard/dashboard-block';
import { requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: 'Overview' };

/**
 * The page itself awaits only the (cached) workspace the layout already loaded. Each block below is an async
 * Server Component behind its own Suspense boundary, so the shell and every skeleton are flushed immediately and
 * the blocks stream in independently, in whatever order their data arrives.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const workspace = await requireWorkspace(workspaceId);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <DashboardBlock title="Recent documents" loadingLabel="Loading recent documents" rows={4}>
        <RecentDocumentsBlock workspaceId={workspaceId} />
      </DashboardBlock>
      <DashboardBlock
        title="Members"
        loadingLabel="Loading members"
        rows={4}
        action={
          roleAtLeast(workspace.role, 'ADMIN') ? (
            <Link
              className="text-xs underline underline-offset-4"
              href={`/workspaces/${workspaceId}/settings`}
            >
              Settings
            </Link>
          ) : null
        }
      >
        <MembersBlock workspaceId={workspaceId} role={workspace.role} />
      </DashboardBlock>
      <DashboardBlock title="Plan & usage" loadingLabel="Loading plan and usage" rows={3}>
        <UsageBlock workspaceId={workspaceId} />
      </DashboardBlock>
      <DashboardBlock title="Shared with me" loadingLabel="Loading shared documents" rows={3}>
        <SharedWithMeBlock workspaceId={workspaceId} />
      </DashboardBlock>
    </div>
  );
}
