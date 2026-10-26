'use client';

import { attachmentUrlSchema } from '@collab-docs/shared';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiClient } from '@/lib/api/client';
import { attachmentUrlKey } from './queries';

/** Signed read URLs for several attachments at once, as a lookup for `ContentRenderer.resolveImageSrc`. */
export function useAttachmentUrls(attachmentIds: readonly string[]): Map<string, string> {
  const unique = useMemo(() => [...new Set(attachmentIds)], [attachmentIds]);
  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: attachmentUrlKey(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiClient.request(`/attachments/${id}/url`, { schema: attachmentUrlSchema, signal }),
      staleTime: 4 * 60_000,
      retry: false,
    })),
  });
  const resolved = results.map((result) => result.data?.url ?? '').join('\n');
  return useMemo(() => {
    const urls = new Map<string, string>();
    results.forEach((result, index) => {
      const id = unique[index];
      if (id && result.data) urls.set(id, result.data.url);
    });
    return urls;
    // `results` is a new array on every render; `resolved` changes only when a URL does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unique, resolved]);
}
