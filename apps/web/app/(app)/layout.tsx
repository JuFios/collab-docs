import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Navbar } from '@/components/navbar';
import { Providers } from '@/components/providers';
import { isApiError } from '@/lib/api/errors';
import { getCurrentUser, getUnreadCount, getWorkspaces } from '@/lib/workspaces/data';

// the only layout that reads the session: public pages above it stay static
export default async function AppLayout({ children }: { children: ReactNode }) {
  const [user, workspaces, unread] = await Promise.all([
    getCurrentUser().catch((error: unknown) => {
      // the middleware already filtered expired sessions; this covers a token revoked between the two checks
      if (isApiError(error) && error.status === 401) redirect('/login');
      throw error;
    }),
    // the switcher is a convenience: if the list cannot be loaded the page itself still renders
    getWorkspaces().catch(() => null),
    // the badge is a convenience too: without a number the bell asks for it from the browser
    getUnreadCount().catch(() => null),
  ]);
  return (
    <Providers>
      <div className="min-h-screen">
        <Navbar user={user} workspaces={workspaces} unreadCount={unread?.count} />
        <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
      </div>
    </Providers>
  );
}
