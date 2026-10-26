'use client';

import type { NotificationPage } from '@collab-docs/shared';
import Link from 'next/link';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { notificationHref } from '@/lib/notifications/links';
import { useMarkRead, useNotificationList, useUnreadCount } from '@/lib/notifications/queries';
import { NotificationContent } from './notification-content';

/**
 * The `/notifications` page body. The server rendered the first page; from there the list is a client query that
 * the workspace stream and the bell keep fresh.
 */
export function NotificationsList({ initialPage }: { initialPage: NotificationPage }) {
  const list = useNotificationList({ initialPage });
  const unread = useUnreadCount();
  const markRead = useMarkRead();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const count = unread.data?.count ?? 0;

  return (
    <section aria-labelledby="notifications-heading" className="mx-auto grid max-w-3xl gap-4">
      <div className="flex items-center gap-3">
        <h1 id="notifications-heading" className="text-2xl font-semibold">
          Notifications
        </h1>
        {count > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
          >
            Mark all as read
          </Button>
        ) : null}
      </div>

      {list.isPending ? <LoadingState label="Loading notifications…" /> : null}
      {list.isError && items.length === 0 ? (
        <ErrorState title="Could not load notifications">
          <Button type="button" variant="outline" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </ErrorState>
      ) : null}
      {list.data && items.length === 0 ? (
        <EmptyState
          title="No notifications yet"
          description="When someone mentions you in a comment, it shows up here."
        />
      ) : null}
      {items.length > 0 ? (
        <ul aria-label="Notifications" className="divide-y rounded-lg border bg-card">
          {items.map((notification) => (
            <li key={notification.id}>
              <Link
                href={notificationHref(notification)}
                onClick={() => {
                  if (!notification.read) markRead.mutate({ ids: [notification.id] });
                }}
                className="flex items-start gap-3 px-4 py-3 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <NotificationContent notification={notification} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {list.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          className="justify-self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </section>
  );
}
