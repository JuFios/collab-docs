'use client';

import { Bell, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { notificationHref } from '@/lib/notifications/links';
import { useMarkRead, useNotificationList, useUnreadCount } from '@/lib/notifications/queries';
import { NotificationContent } from './notification-content';

/** Newest notifications shown in the menu; the rest is one click away on /notifications. */
const MENU_SIZE = 8;

/**
 * The bell in the navbar: unread badge, and a menu with the latest notifications. The badge is kept current by the
 * workspace stream (`notification.created`, wired in `WorkspaceProvider`), by a refetch when the window gets focus
 * and by a slow poll for pages outside a workspace, which have no stream.
 */
export function NotificationBell({ initialCount }: { initialCount?: number }) {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount(initialCount);
  const list = useNotificationList({ enabled: open });
  const markRead = useMarkRead();
  const count = unread.data?.count ?? 0;
  const items = list.data?.pages.flatMap((page) => page.items).slice(0, MENU_SIZE) ?? [];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
          data-testid="notifications-bell"
        >
          <Bell className="h-4 w-4" aria-hidden />
          {count > 0 ? (
            <span
              aria-hidden
              data-testid="unread-badge"
              className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
            >
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 max-w-[calc(100vw-2rem)]">
        <div className="flex items-center justify-between pr-1">
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          {count > 0 ? (
            // a menu item, so the arrow keys reach it; it keeps the menu open, as the list changes under it
            <DropdownMenuItem
              disabled={markRead.isPending}
              className="mr-1 w-auto shrink-0 px-2 py-1 text-xs"
              onSelect={(event) => {
                event.preventDefault();
                markRead.mutate({ all: true });
              }}
            >
              Mark all as read
            </DropdownMenuItem>
          ) : null}
        </div>
        {/* a menu may only hold menu items, labels and separators, so the states are built from those */}
        {list.isPending && open ? (
          <DropdownMenuItem disabled className="justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading notifications…
          </DropdownMenuItem>
        ) : null}
        {list.isError ? (
          <>
            <DropdownMenuLabel className="font-normal text-destructive">
              Could not load notifications.
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={(event) => {
                // keeps the menu open, so the list replaces the error in place
                event.preventDefault();
                void list.refetch();
              }}
            >
              Try again
            </DropdownMenuItem>
          </>
        ) : null}
        {list.data && items.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            You&apos;re all caught up.
          </p>
        ) : null}
        {items.map((notification) => (
          <DropdownMenuItem
            key={notification.id}
            asChild
            onSelect={() => {
              if (!notification.read) markRead.mutate({ ids: [notification.id] });
            }}
          >
            <Link href={notificationHref(notification)} className="items-start">
              <NotificationContent notification={notification} />
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/notifications" className="justify-center">
            See all notifications
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
