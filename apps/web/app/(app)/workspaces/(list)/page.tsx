import { roleAtLeast } from '@collab-docs/shared';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { EmptyState } from '@/components/states';
import { CreateWorkspaceForm } from '@/components/workspaces/create-workspace-form';
import { getWorkspaces } from '@/lib/workspaces/data';
import { LAST_WORKSPACE_COOKIE } from '@/lib/workspaces/last-workspace';
import { ROLE_LABELS } from '@/lib/workspaces/labels';

export const metadata: Metadata = { title: 'Workspaces' };

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const [{ all }, workspaces, cookieStore] = await Promise.all([
    searchParams,
    getWorkspaces(),
    cookies(),
  ]);
  const last = cookieStore.get(LAST_WORKSPACE_COOKIE)?.value;
  // straight back to where the user was; `?all` (the switcher's "All workspaces") shows the list instead
  if (all === undefined && last && workspaces.some((workspace) => workspace.id === last)) {
    redirect(`/workspaces/${last}`);
  }

  return (
    <div className="grid gap-8">
      <section aria-labelledby="workspaces-heading">
        <h1 id="workspaces-heading" className="mb-4 text-2xl font-semibold">
          Workspaces
        </h1>
        {workspaces.length === 0 ? (
          <EmptyState
            title="No workspaces yet"
            description="Create your first workspace to start writing documents with your team."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  href={`/workspaces/${workspace.id}`}
                  className="block rounded-lg border bg-card p-4 transition-colors hover:bg-accent"
                >
                  <div className="font-medium">{workspace.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {ROLE_LABELS[workspace.role]}
                    {roleAtLeast(workspace.role, 'ADMIN') ? ' · can manage' : ''} ·{' '}
                    {workspace.plan.toLowerCase()} plan
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="create-heading" className="max-w-md rounded-lg border bg-card p-4">
        <h2 id="create-heading" className="mb-3 text-base font-semibold">
          Create a workspace
        </h2>
        <CreateWorkspaceForm />
      </section>
    </div>
  );
}
