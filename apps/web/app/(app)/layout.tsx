import { authUserSchema } from '@collab-docs/shared';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Navbar } from '@/components/navbar';
import { isApiError } from '@/lib/api/errors';
import { apiServer } from '@/lib/api/server';

// the only layout that reads the session: public pages above it stay static
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await apiServer('/auth/me', { schema: authUserSchema }).catch((error: unknown) => {
    // the middleware already filtered expired sessions; this covers a token revoked between the two checks
    if (isApiError(error) && error.status === 401) redirect('/login');
    throw error;
  });
  return (
    <div className="min-h-screen">
      <Navbar user={user} />
      <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
    </div>
  );
}
