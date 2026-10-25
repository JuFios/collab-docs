'use client';

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useRestoreDocument, useTrash } from '@/lib/documents/queries';

/**
 * Shown when a document stops being readable while it is open. The api answers 404 for both "deleted" and "no
 * longer shared with you"; a workspace member can tell them apart through the trash, which lists what they may restore.
 */
export function DocumentGone({
  workspaceId,
  documentId,
  member,
}: {
  workspaceId: string;
  documentId: string;
  member: boolean;
}) {
  const router = useRouter();
  const trash = useTrash(workspaceId, member);
  const restore = useRestoreDocument(workspaceId);
  const item = trash.data?.find((candidate) => candidate.id === documentId);

  if (!member || trash.isPending || !item) {
    return (
      <EmptyState
        title="This document is no longer available"
        description="It was deleted, or it is no longer shared with you."
      >
        {member && trash.isPending ? null : (
          <Button
            variant="outline"
            onClick={() => router.push(member ? `/w/${workspaceId}` : '/shared')}
          >
            {member ? 'Back to the workspace' : 'Back to shared documents'}
          </Button>
        )}
      </EmptyState>
    );
  }
  return (
    <EmptyState
      title="This document was deleted"
      description={
        item.canRestore
          ? 'It is in the trash. Restore it to open it again.'
          : 'It is in the trash. An owner or admin can restore it.'
      }
    >
      <div className="flex gap-2">
        {item.canRestore ? (
          <Button
            disabled={restore.isPending}
            onClick={() =>
              restore.mutate(
                { id: documentId },
                {
                  onSuccess: () => {
                    toast.success('Document restored');
                    router.refresh();
                  },
                },
              )
            }
          >
            {restore.isPending ? 'Restoring…' : 'Restore'}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => router.push(`/w/${workspaceId}/trash`)}>
          Open trash
        </Button>
      </div>
    </EmptyState>
  );
}
