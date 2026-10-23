'use client';

import {
  DEFAULT_DOCUMENT_TITLE,
  type DocumentDetails,
  type TreeNode,
  documentSchema,
  movedDocumentSchema,
  trashItemListSchema,
  treeNodeListSchema,
} from '@collab-docs/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/components/workspaces/workspace-provider';
import { apiClient } from '@/lib/api/client';
import { DOCUMENTS_KEY, documentKey, trashKey, treeKey } from './keys';
import { type MovePlan, applyMove } from './move';
import { descendantIds } from './tree';

/** The flat tree. Seeded by the layout, then kept fresh by `tree.changed` and by the mutations below. */
export function useTree() {
  const { workspaceId, initialTree } = useWorkspace();
  return useQuery({
    queryKey: treeKey(workspaceId),
    queryFn: ({ signal }) =>
      apiClient.request(`/workspaces/${workspaceId}/documents/tree`, {
        schema: treeNodeListSchema,
        signal,
      }),
    initialData: initialTree,
    // the layout fetched it moments ago; the stream is what signals a change
    staleTime: 60_000,
  });
}

export function useTrash(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: trashKey(workspaceId),
    queryFn: ({ signal }) =>
      apiClient.request(`/workspaces/${workspaceId}/trash`, {
        schema: trashItemListSchema,
        signal,
      }),
    enabled,
  });
}

export function useDocumentQuery(documentId: string, initialData: DocumentDetails | undefined) {
  return useQuery({
    queryKey: documentKey(documentId),
    queryFn: ({ signal }) =>
      apiClient.request(`/documents/${documentId}`, { schema: documentSchema, signal }),
    initialData,
    // a 404 here means "deleted or no longer shared"; retrying would only delay the state that says so
    retry: false,
  });
}

/**
 * Tree writes of one workspace run one after another, in the order the user made them. Without a scope, quick
 * successive keyboard moves are separate parallel requests and the server may apply them in a different order than
 * the one the optimistic tree on screen shows.
 */
const treeScope = (workspaceId: string) => ({ id: `tree:${workspaceId}` });

interface TreeSnapshot {
  previous: TreeNode[] | undefined;
}

/** Applies `change` to the cached tree right away and returns what is needed to put it back. */
async function patchTree(
  queryClient: QueryClient,
  workspaceId: string,
  change: (nodes: TreeNode[]) => TreeNode[],
): Promise<TreeSnapshot> {
  const key = treeKey(workspaceId);
  await queryClient.cancelQueries({ queryKey: key });
  const previous = queryClient.getQueryData<TreeNode[]>(key);
  if (previous) queryClient.setQueryData<TreeNode[]>(key, change(previous));
  return { previous };
}

function rollback(queryClient: QueryClient, workspaceId: string, snapshot?: TreeSnapshot) {
  if (snapshot?.previous) queryClient.setQueryData(treeKey(workspaceId), snapshot.previous);
}

export function useMoveDocument(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: treeScope(workspaceId),
    mutationFn: ({ id, plan }: { id: string; plan: MovePlan }) =>
      apiClient.request(`/documents/${id}/move`, {
        method: 'POST',
        body: plan,
        schema: movedDocumentSchema,
      }),
    onMutate: ({ id, plan }) =>
      patchTree(queryClient, workspaceId, (nodes) => applyMove(nodes, id, plan)),
    onError: (_error, _variables, snapshot) => rollback(queryClient, workspaceId, snapshot),
    onSettled: () => queryClient.invalidateQueries({ queryKey: treeKey(workspaceId) }),
  });
}

function toNode(document: DocumentDetails): TreeNode {
  return {
    id: document.id,
    parentId: document.parentId,
    title: document.title,
    icon: document.icon,
    position: document.position,
    visibility: document.visibility,
    myAccess: document.myAccess,
  };
}

export function useCreateDocument(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: treeScope(workspaceId),
    mutationFn: ({ parentId }: { parentId?: string }) =>
      apiClient.request(`/workspaces/${workspaceId}/documents`, {
        method: 'POST',
        body: { parentId, title: DEFAULT_DOCUMENT_TITLE },
        schema: documentSchema,
      }),
    onSuccess: (document) => {
      queryClient.setQueryData<TreeNode[]>(treeKey(workspaceId), (nodes) =>
        nodes && !nodes.some((node) => node.id === document.id)
          ? [...nodes, toNode(document)]
          : nodes,
      );
      queryClient.setQueryData(documentKey(document.id), document);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: treeKey(workspaceId) }),
  });
}

export function useRenameDocument(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: treeScope(workspaceId),
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiClient.request(`/documents/${id}`, {
        method: 'PATCH',
        body: { title },
        schema: documentSchema,
      }),
    onMutate: ({ id, title }) =>
      patchTree(queryClient, workspaceId, (nodes) =>
        nodes.map((node) => (node.id === id ? { ...node, title } : node)),
      ),
    onSuccess: (document) => queryClient.setQueryData(documentKey(document.id), document),
    onError: (_error, _variables, snapshot) => rollback(queryClient, workspaceId, snapshot),
    onSettled: () => queryClient.invalidateQueries({ queryKey: treeKey(workspaceId) }),
  });
}

export function useDeleteDocument(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: treeScope(workspaceId),
    mutationFn: ({ id }: { id: string }) =>
      apiClient.request(`/documents/${id}`, { method: 'DELETE' }),
    onMutate: ({ id }) =>
      patchTree(queryClient, workspaceId, (nodes) => {
        const gone = new Set([id, ...descendantIds(nodes, id)]);
        return nodes.filter((node) => !gone.has(node.id));
      }),
    onError: (_error, _variables, snapshot) => rollback(queryClient, workspaceId, snapshot),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: treeKey(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: trashKey(workspaceId) });
    },
  });
}

export function useRestoreDocument(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: treeScope(workspaceId),
    mutationFn: ({ id }: { id: string }) =>
      apiClient.request(`/documents/${id}/restore`, { method: 'POST', schema: documentSchema }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: treeKey(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: trashKey(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY });
    },
  });
}
