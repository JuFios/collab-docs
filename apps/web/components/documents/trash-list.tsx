'use client';

import type { TrashItem } from '@collab-docs/shared';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useRestoreDocument } from '@/lib/documents/queries';
import { formatRelative } from '@/lib/workspaces/labels';

/** Client component: Restore runs from an event handler, then the server-rendered list is refreshed. */
export function TrashList({
  workspaceId,
  items,
}: {
  workspaceId: string;
  items: readonly TrashItem[];
}) {
  const router = useRouter();
  const restore = useRestoreDocument(workspaceId);

  return (
    <ul className="divide-y rounded-lg border bg-card">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-3 px-4 py-3 text-sm">
          <span aria-hidden>{item.icon ?? '📄'}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{item.title || 'Untitled'}</span>
            <span className="text-xs text-muted-foreground">
              Deleted {formatRelative(item.deletedAt)}
              {item.documentCount > 1 ? ` · with ${item.documentCount - 1} subpages` : ''}
            </span>
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!item.canRestore || restore.isPending}
            title={item.canRestore ? undefined : 'Only owners, admins or the author can restore it'}
            onClick={() =>
              restore.mutate(
                { id: item.id },
                {
                  onSuccess: (document) => {
                    toast.success(`Restored “${document.title || 'Untitled'}”`);
                    router.refresh();
                  },
                },
              )
            }
          >
            Restore
          </Button>
        </li>
      ))}
    </ul>
  );
}
