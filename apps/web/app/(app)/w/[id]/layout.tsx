import { roleAtLeast } from '@collab-docs/shared';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ForbiddenState } from '@/components/states';
import { WorkspaceNav } from '@/components/workspaces/workspace-nav';
import { isApiError } from '@/lib/api/errors';
import { getWorkspace } from '@/lib/workspaces/data';
import { ROLE_LABELS } from '@/lib/workspaces/labels';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let workspace;
  try {
    workspace = await getWorkspace(id);
  } catch (error) {
    // not a member and an id that is not even a uuid look the same on purpose
    if (isApiError(error) && (error.status === 404 || error.status === 400)) notFound();
    if (isApiError(error) && error.status === 403) return <ForbiddenState />;
    throw error;
  }
  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold">{workspace.name}</h1>
          <span className="text-xs text-muted-foreground">
            {ROLE_LABELS[workspace.role]} · {workspace.plan.toLowerCase()} plan
          </span>
        </div>
        <WorkspaceNav workspaceId={workspace.id} canManage={roleAtLeast(workspace.role, 'ADMIN')} />
      </header>
      {children}
    </div>
  );
}
