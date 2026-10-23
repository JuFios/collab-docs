'use client';

import type { TreeNode } from '@collab-docs/shared';
import { useParams, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { useWorkspace } from '@/components/workspaces/workspace-provider';
import { useCreateDocument, useDeleteDocument, useTree } from '@/lib/documents/queries';
import { requestTitleFocus } from '@/lib/documents/title-focus';
import { descendantIds } from '@/lib/documents/tree';

/** Create and delete with their navigation and toasts, shared by the tree, its menus and the document header. */
export function useDocumentActions(onCreated?: (parentId: string) => void) {
  const { workspaceId } = useWorkspace();
  const router = useRouter();
  const params = useParams<{ docId?: string }>();
  const { data: nodes } = useTree();
  const create = useCreateDocument(workspaceId);
  const remove = useDeleteDocument(workspaceId);

  const createDocument = useCallback(
    async (parentId?: string) => {
      const document = await create.mutateAsync({ parentId }).catch(() => null);
      if (!document) return; // the global handler already told the user why
      if (parentId) onCreated?.(parentId);
      requestTitleFocus(document.id);
      router.push(`/w/${workspaceId}/d/${document.id}`);
    },
    [create, onCreated, router, workspaceId],
  );

  const deleteDocument = useCallback(
    async (node: Pick<TreeNode, 'id'>) => {
      const gone = new Set([node.id, ...descendantIds(nodes ?? [], node.id)]);
      const ok = await remove.mutateAsync({ id: node.id }).then(
        () => true,
        () => false,
      );
      if (!ok) return false;
      toast.success('Moved to trash', {
        action: { label: 'Open trash', onClick: () => router.push(`/w/${workspaceId}/trash`) },
      });
      if (params.docId && gone.has(params.docId)) router.push(`/w/${workspaceId}`);
      return true;
    },
    [nodes, params.docId, remove, router, workspaceId],
  );

  return {
    createDocument,
    deleteDocument,
    creating: create.isPending,
    deleting: remove.isPending,
  };
}
