import type { AuthUser, Workspace } from '@collab-docs/shared';
import Link from 'next/link';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { UserMenu } from '@/components/user-menu';
import { WorkspaceSwitcher } from '@/components/workspaces/workspace-switcher';

/** Server Component shell; the switcher, the notification bell and the user menu are the only client islands. */
export function Navbar({
  user,
  workspaces,
  unreadCount,
}: {
  user: AuthUser;
  /** `null` when the list could not be loaded; the rest of the page still works. */
  workspaces: readonly Workspace[] | null;
  /** `undefined` when it could not be loaded; the bell then fetches it itself. */
  unreadCount?: number;
}) {
  return (
    <header className="border-b bg-background">
      <nav
        className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4"
        aria-label="Main"
      >
        <div className="flex items-center gap-4">
          <Link href="/w" className="font-semibold">
            Collab Docs
          </Link>
          {workspaces ? <WorkspaceSwitcher workspaces={workspaces} /> : null}
        </div>
        <div className="flex items-center gap-1">
          <NotificationBell initialCount={unreadCount} />
          <UserMenu user={user} />
        </div>
      </nav>
    </header>
  );
}
