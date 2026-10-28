import type { Metadata } from 'next';
import { TrashList } from '@/components/documents/trash-list';
import { EmptyState } from '@/components/states';
import { getTrash, requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: 'Trash' };

export default async function TrashPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireWorkspace(id);
  const items = await getTrash(id);
  return (
    <section aria-labelledby="trash-heading" className="grid gap-4">
      <h2 id="trash-heading" className="text-lg font-semibold">
        Trash
      </h2>
      {items.length === 0 ? (
        <EmptyState
          title="The trash is empty"
          description="Deleted documents show up here, with their subpages, until you restore them."
        />
      ) : (
        <TrashList workspaceId={id} items={items} />
      )}
    </section>
  );
}
