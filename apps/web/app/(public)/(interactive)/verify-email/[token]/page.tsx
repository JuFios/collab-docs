import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { isApiError } from '@/lib/api/errors';
import { apiServer } from '@/lib/api/server';

export const metadata: Metadata = {
  title: 'Confirm email',
  // the URL carries a secret token
  robots: { index: false },
  referrer: 'no-referrer',
};

/**
 * Opening the link from the confirmation email confirms the address: the token is the proof, so no session is
 * needed and the page works without JavaScript. Opening it again while it is valid confirms nothing new and says
 * the same.
 */
export default async function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    await apiServer('/auth/verify-email', { method: 'POST', body: { token } });
  } catch (error) {
    if (isApiError(error) && error.status === 400) {
      return (
        <AuthCard
          title="Link not valid"
          description="This confirmation link has expired or a newer one was sent. Sign in and send yourself a new link from the notice at the top of the page."
        >
          <Button asChild variant="outline" className="w-full">
            <Link href="/workspaces">Go to your workspaces</Link>
          </Button>
        </AuthCard>
      );
    }
    throw error;
  }
  return (
    <AuthCard
      title="Email address confirmed"
      description="Your address is confirmed: people can now share documents with you."
    >
      <Button asChild className="w-full">
        <Link href="/workspaces">Go to your workspaces</Link>
      </Button>
    </AuthCard>
  );
}
