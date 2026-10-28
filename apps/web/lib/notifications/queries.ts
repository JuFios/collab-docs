'use client';

import {
  type NotificationPage,
  markReadResultSchema,
  notificationPageSchema,
  unreadCountSchema,
} from '@collab-docs/shared';
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';

export const NOTIFICATIONS_KEY = ['notifications'] as const;
const unreadKey = [...NOTIFICATIONS_KEY, 'unread'] as const;
const listKey = [...NOTIFICATIONS_KEY, 'list'] as const;

const PAGE_SIZE = 20;
/** Safety net next to the live stream (and the only update outside a workspace, where no stream is open). */
const POLL_MS = 60_000;

type ListData = InfiniteData<NotificationPage, string | undefined>;

export function fetchNotificationPage(
  cursor: string | undefined,
  limit = PAGE_SIZE,
  signal?: AbortSignal,
): Promise<NotificationPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return apiClient.request(`/notifications?${params.toString()}`, {
    schema: notificationPageSchema,
    signal,
  });
}

/**
 * The unread badge. A pushed `notification.created` refreshes it at once (see `useNotificationEvents`); the
 * window-focus refetch and the slow poll cover tabs without a stream and anything the stream missed.
 */
export function useUnreadCount(initialCount?: number) {
  return useQuery({
    queryKey: unreadKey,
    queryFn: ({ signal }) =>
      apiClient.request('/notifications/unread-count', { schema: unreadCountSchema, signal }),
    initialData: initialCount === undefined ? undefined : { count: initialCount },
    refetchInterval: POLL_MS,
  });
}

/** Newest first, a page at a time. The `/notifications` page seeds it with the page it rendered on the server. */
export function useNotificationList({
  initialPage,
  enabled = true,
}: {
  initialPage?: NotificationPage;
  enabled?: boolean;
}) {
  return useInfiniteQuery({
    queryKey: listKey,
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchNotificationPage(pageParam, PAGE_SIZE, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    initialData: initialPage ? { pages: [initialPage], pageParams: [undefined] } : undefined,
  });
}

type MarkRead = { ids: string[] } | { all: true };

function markedRead(data: ListData | undefined, target: MarkRead): ListData | undefined {
  if (!data) return data;
  const ids = 'ids' in target ? new Set(target.ids) : null;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (ids && !ids.has(item.id) ? item : { ...item, read: true })),
    })),
  };
}

function unreadAmong(data: ListData | undefined, target: MarkRead): number {
  const ids = 'ids' in target ? new Set(target.ids) : null;
  return (data?.pages ?? [])
    .flatMap((page) => page.items)
    .filter((item) => !item.read && (!ids || ids.has(item.id))).length;
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (target: MarkRead) =>
      apiClient.request('/notifications/read', {
        method: 'POST',
        body: target,
        schema: markReadResultSchema,
      }),
    onMutate: async (target) => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      const previousList = queryClient.getQueryData<ListData>(listKey);
      const previousCount = queryClient.getQueryData<{ count: number }>(unreadKey);
      queryClient.setQueryData<ListData>(listKey, (data) => markedRead(data, target));
      if (previousCount) {
        // the badge counts everything unread, the loaded list may hold only some of it
        const next = 'all' in target ? 0 : previousCount.count - unreadAmong(previousList, target);
        queryClient.setQueryData(unreadKey, { count: Math.max(0, next) });
      }
      return { previousList, previousCount };
    },
    onError: (_error, _target, context) => {
      if (context?.previousList) queryClient.setQueryData(listKey, context.previousList);
      if (context?.previousCount) queryClient.setQueryData(unreadKey, context.previousCount);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

/** For code outside React (the stream handler): refresh the badge and any list that is on screen. */
export function refreshNotifications(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
}
