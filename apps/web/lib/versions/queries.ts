'use client';

import {
  createdVersionSchema,
  documentVersionContentSchema,
  documentVersionListSchema,
  restoredVersionSchema,
} from '@collab-docs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';

const versionsKey = (documentId: string) => ['versions', documentId] as const;
const versionKey = (documentId: string, versionId: string) =>
  ['versions', documentId, versionId] as const;

export function useVersions(documentId: string, enabled: boolean) {
  return useQuery({
    queryKey: versionsKey(documentId),
    enabled,
    queryFn: ({ signal }) =>
      apiClient.request(`/documents/${documentId}/versions`, {
        schema: documentVersionListSchema,
        signal,
      }),
  });
}

/** A version's content never changes, so a loaded preview stays valid for the session. */
export function useVersionContent(documentId: string, versionId: string | null) {
  return useQuery({
    queryKey: versionKey(documentId, versionId ?? ''),
    enabled: versionId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) =>
      apiClient.request(`/documents/${documentId}/versions/${versionId}`, {
        schema: documentVersionContentSchema,
        signal,
      }),
  });
}

export function useCreateVersion(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string | undefined) =>
      apiClient.request(`/documents/${documentId}/versions`, {
        method: 'POST',
        body: label ? { label } : {},
        schema: createdVersionSchema,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: versionsKey(documentId) }),
  });
}

export function useRestoreVersion(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      apiClient.request(`/documents/${documentId}/versions/${versionId}/restore`, {
        method: 'POST',
        schema: restoredVersionSchema,
      }),
    // restoring snapshots the current content first (a PRE_RESTORE version)
    onSettled: () => queryClient.invalidateQueries({ queryKey: versionsKey(documentId) }),
  });
}
