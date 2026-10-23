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
import { getWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: 'Overview · Collab Docs' };

/**
 * The page itself awaits only the (cached) workspace the layout already loaded. Each block below is an async
 * Server Component behind its own Suspense boundary, so the shell and every skeleton are flushed immediately and
 * the blocks stream in independently, in whatever order their data arrives.
 */
export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await getWorkspace(id);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <DashboardBlock title="Recent documents" loadingLabel="Loading recent documents" rows={4}>
        <RecentDocumentsBlock workspaceId={id} />
      </DashboardBlock>
      <DashboardBlock
        title="Members"
        loadingLabel="Loading members"
        rows={4}
        action={
          roleAtLeast(workspace.role, 'ADMIN') ? (
            <Link className="text-xs underline underline-offset-4" href={`/w/${id}/settings`}>
              Settings
            </Link>
          ) : null
        }
      >
        <MembersBlock workspaceId={id} role={workspace.role} />
      </DashboardBlock>
      <DashboardBlock title="Plan & usage" loadingLabel="Loading plan and usage" rows={3}>
        <UsageBlock workspaceId={id} />
      </DashboardBlock>
      <DashboardBlock title="Shared with me" loadingLabel="Loading shared documents" rows={3}>
        <SharedWithMeBlock workspaceId={id} />
      </DashboardBlock>
    </div>
  );
}
