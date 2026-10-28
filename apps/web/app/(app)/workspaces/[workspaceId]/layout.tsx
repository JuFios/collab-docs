import { roleAtLeast } from '@collab-docs/shared';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { PlanLimitDialog } from '@/components/billing/plan-limit-dialog';
import { WorkspaceSidebar } from '@/components/documents/workspace-sidebar';
import { ForbiddenState } from '@/components/states';
import { LeaveWorkspaceButton } from '@/components/workspaces/leave-workspace-button';
import { WorkspaceNav } from '@/components/workspaces/workspace-nav';
import { WorkspaceProvider } from '@/components/workspaces/workspace-provider';
import { isApiError } from '@/lib/api/errors';
import { getCurrentUser, getTree, getWorkspace } from '@/lib/workspaces/data';
import { ROLE_LABELS } from '@/lib/workspaces/labels';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  // fetched alongside the workspace; if only the tree fails, the sidebar loads it again on the client
  const treeRequest = getTree(workspaceId).catch(() => undefined);
  let workspace;
  try {
    workspace = await getWorkspace(workspaceId);
  } catch (error) {
    if (isApiError(error) && error.status === 400) notFound();
    // Not a member: either a stranger or a guest who was given a share. The frame (sidebar, stream) is for members
    // only, so the children render bare and every page decides for itself: the document page checks the share,
    // all others call requireWorkspace() and answer 404.
    if (isApiError(error) && error.status === 404) {
      return (
        <>
          {children}
          <PlanLimitDialog />
        </>
      );
    }
    if (isApiError(error) && error.status === 403) return <ForbiddenState />;
    throw error;
  }
  const [user, initialTree] = await Promise.all([getCurrentUser(), treeRequest]);
  return (
    <WorkspaceProvider workspaceId={workspace.id} role={workspace.role} initialTree={initialTree}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[17rem_minmax(0,1fr)]">
        <WorkspaceSidebar />
        <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-6">
          <header className="grid gap-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <h1 className="text-2xl font-semibold">{workspace.name}</h1>
              <span className="text-xs text-muted-foreground">
                {ROLE_LABELS[workspace.role]} · {workspace.plan.toLowerCase()} plan
              </span>
              <span className="ml-auto">
                <LeaveWorkspaceButton
                  workspaceId={workspace.id}
                  workspaceName={workspace.name}
                  userId={user.id}
                />
              </span>
            </div>
            <WorkspaceNav
              workspaceId={workspace.id}
              canManage={roleAtLeast(workspace.role, 'ADMIN')}
            />
          </header>
          {children}
        </div>
      </div>
      <PlanLimitDialog />
    </WorkspaceProvider>
  );
}
