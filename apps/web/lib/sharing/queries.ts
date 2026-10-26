'use client';

import {
  type CreatePublicLinkInput,
  type ShareRole,
  createdPublicLinkSchema,
  documentSchema,
  publicLinkListSchema,
  publicLinkSchema,
  shareListSchema,
  shareSchema,
} from '@collab-docs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { documentKey } from '@/lib/documents/keys';

const sharesKey = (documentId: string) => ['shares', documentId] as const;
const linksKey = (documentId: string) => ['public-links', documentId] as const;

export function useShares(documentId: string, enabled: boolean) {
  return useQuery({
    queryKey: sharesKey(documentId),
    enabled,
    queryFn: ({ signal }) =>
      apiClient.request(`/documents/${documentId}/shares`, { schema: shareListSchema, signal }),
  });
}

export function useAddShare(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role: ShareRole }) =>
      apiClient.request(`/documents/${documentId}/shares`, {
        method: 'POST',
        body: input,
        schema: shareSchema,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: sharesKey(documentId) }),
  });
}

export function useChangeShare(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ShareRole }) =>
      apiClient.request(`/documents/${documentId}/shares/${userId}`, {
        method: 'PATCH',
        body: { role },
        schema: shareSchema,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: sharesKey(documentId) }),
  });
}

export function useRemoveShare(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiClient.request(`/documents/${documentId}/shares/${userId}`, { method: 'DELETE' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: sharesKey(documentId) }),
  });
}

export function useSetVisibility(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (visibility: 'WORKSPACE' | 'RESTRICTED') =>
      apiClient.request(`/documents/${documentId}`, {
        method: 'PATCH',
        body: { visibility },
        schema: documentSchema,
      }),
    onSuccess: (document) => queryClient.setQueryData(documentKey(document.id), document),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['tree'] }),
  });
}

export function usePublicLinks(documentId: string, enabled: boolean) {
  return useQuery({
    queryKey: linksKey(documentId),
    enabled,
    queryFn: ({ signal }) =>
      apiClient.request(`/documents/${documentId}/public-links`, {
        schema: publicLinkListSchema,
        signal,
      }),
  });
}

export function useCreatePublicLink(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePublicLinkInput) =>
      apiClient.request(`/documents/${documentId}/public-links`, {
        method: 'POST',
        body: input,
        schema: createdPublicLinkSchema,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: linksKey(documentId) }),
  });
}

export function useUpdatePublicLink(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ linkId, expiresAt }: { linkId: string; expiresAt: string | null }) =>
      apiClient.request(`/documents/${documentId}/public-links/${linkId}`, {
        method: 'PATCH',
        body: { expiresAt },
        schema: publicLinkSchema,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: linksKey(documentId) }),
  });
}

export function useRevokePublicLink(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) =>
      apiClient.request(`/documents/${documentId}/public-links/${linkId}`, { method: 'DELETE' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: linksKey(documentId) }),
  });
}
