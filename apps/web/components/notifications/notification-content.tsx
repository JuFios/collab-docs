import type { NotificationResponse } from '@collab-docs/shared';
import { cn } from '@/lib/utils';
import { notificationTitle } from '@/lib/notifications/links';

const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * What a notification says. The names, the title and the excerpt are snapshots written by the api and rendered
 * as text only; the unread state is a visible dot and also spoken.
 */
export function NotificationContent({ notification }: { notification: NotificationResponse }) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
          notification.read ? 'bg-transparent' : 'bg-primary',
        )}
      />
      <span className="grid min-w-0 gap-0.5">
        <span className={cn('text-sm', !notification.read && 'font-medium')}>
          {notification.read ? null : <span className="sr-only">Unread: </span>}
          {notificationTitle(notification)}
        </span>
        {notification.payload.excerpt ? (
          <span className="line-clamp-2 break-words text-xs text-muted-foreground">
            {notification.payload.excerpt}
          </span>
        ) : null}
        <time dateTime={notification.createdAt} className="text-xs text-muted-foreground">
          {formatter.format(new Date(notification.createdAt))}
        </time>
      </span>
    </>
  );
}
