import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ConfirmEmailBanner } from '@/components/auth/confirm-email-banner';
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
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
        >
          Skip to content
        </a>
        <Navbar user={user} workspaces={workspaces} unreadCount={unread?.count} />
        {user.emailVerified ? null : <ConfirmEmailBanner email={user.email} />}
        <main id="content" className="mx-auto max-w-6xl px-4 py-6">
          {children}
        </main>
      </div>
    </Providers>
  );
}
