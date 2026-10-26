'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { toast } from 'sonner';
import type { WorkspaceEvent } from '@/lib/realtime/events';
import { notificationHref, notificationTitle } from './links';
import { fetchNotificationPage, refreshNotifications, useMarkRead } from './queries';

/**
 * Reacts to `notification.created` from the workspace stream: refreshes the badge and the list, and shows a toast.
 * The event carries only the id, so the toast text comes from the newest notifications.
 */
export function useNotificationEvents(): (event: WorkspaceEvent) => void {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { mutate: markRead } = useMarkRead();

  return useCallback(
    (event) => {
      if (event.type !== 'notification.created') return;
      void refreshNotifications(queryClient);
      void fetchNotificationPage(undefined, 5)
        .then((page) => page.items.find((item) => item.id === event.notificationId))
        .then((item) => {
          if (!item) {
            toast('You have a new notification');
            return;
          }
          toast(notificationTitle(item), {
            description: item.payload.excerpt,
            action: {
              label: 'Open',
              onClick: () => {
                markRead({ ids: [item.id] });
                router.push(notificationHref(item));
              },
            },
          });
        })
        .catch(() => toast('You have a new notification'));
    },
    [queryClient, router, markRead],
  );
}
