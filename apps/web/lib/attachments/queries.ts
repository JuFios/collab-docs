'use client';

import { attachmentUrlSchema } from '@collab-docs/shared';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';

export const attachmentUrlKey = (attachmentId: string) => ['attachment-url', attachmentId] as const;

/** Read URLs are signed and short-lived; refresh a little before the current one expires. */
const REFRESH_MARGIN_MS = 30_000;
const MIN_REFRESH_MS = 10_000;

export function useAttachmentUrl(attachmentId: string | null | undefined) {
  return useQuery({
    queryKey: attachmentUrlKey(attachmentId ?? ''),
    enabled: Boolean(attachmentId),
    queryFn: ({ signal }) =>
      apiClient.request(`/attachments/${attachmentId}/url`, {
        schema: attachmentUrlSchema,
        signal,
      }),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (query) => {
      const expiresAt = query.state.data?.expiresAt;
      if (!expiresAt) return false;
      return Math.max(Date.parse(expiresAt) - Date.now() - REFRESH_MARGIN_MS, MIN_REFRESH_MS);
    },
  });
}
