import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Navbar } from '@/components/navbar';
import { isApiError } from '@/lib/api/errors';
import { getCurrentUser, getWorkspaces } from '@/lib/workspaces/data';

// the only layout that reads the session: public pages above it stay static
export default async function AppLayout({ children }: { children: ReactNode }) {
  const [user, workspaces] = await Promise.all([
    getCurrentUser().catch((error: unknown) => {
      // the middleware already filtered expired sessions; this covers a token revoked between the two checks
      if (isApiError(error) && error.status === 401) redirect('/login');
      throw error;
    }),
    // the switcher is a convenience: if the list cannot be loaded the page itself still renders
    getWorkspaces().catch(() => null),
  ]);
  return (
    <div className="min-h-screen">
      <Navbar user={user} workspaces={workspaces} />
      <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
    </div>
  );
}
