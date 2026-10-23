import { workspaceListSchema } from '@collab-docs/shared';
import { EmptyState } from '@/components/states';
import { apiServer } from '@/lib/api/server';

// Placeholder landing for signed-in users; the dashboard replaces it with the workspace screens.
export default async function WorkspacesPage() {
  const workspaces = await apiServer('/workspaces', { schema: workspaceListSchema });
  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">Workspaces</h1>
      {workspaces.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          description="Workspace creation arrives with the workspace screens."
        />
      ) : (
        <ul className="grid gap-2">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="rounded-md border p-3">
              {workspace.name}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
