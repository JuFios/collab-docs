import { invitePreviewSchema } from '@collab-docs/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { AcceptInviteForm } from '@/components/workspaces/accept-invite-form';
import { isApiError } from '@/lib/api/errors';
import { apiServer } from '@/lib/api/server';
import { logoutAction } from '@/lib/auth/actions';
import { getCurrentUser } from '@/lib/workspaces/data';
import { ROLE_LABELS } from '@/lib/workspaces/labels';

export const metadata: Metadata = {
  title: 'Invitation',
  // the URL carries a secret token
  robots: { index: false },
  referrer: 'no-referrer',
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let preview;
  try {
    preview = await apiServer(`/invites/${encodeURIComponent(token)}`, {
      schema: invitePreviewSchema,
    });
  } catch (error) {
    if (isApiError(error) && (error.code === 'INVITE_INVALID' || error.status === 404)) {
      return (
        <AuthCard
          title="Invitation not valid"
          description="This invitation has expired, was revoked, or has already been used. Ask the workspace admin to send a new one."
        >
          <Button asChild variant="outline" className="w-full">
            <Link href="/w">Go to your workspaces</Link>
          </Button>
        </AuthCard>
      );
    }
    throw error;
  }

  const user = await getCurrentUser().catch((error: unknown) => {
    if (isApiError(error) && error.status === 401) return null;
    throw error;
  });

  const summary = `${preview.inviterName} invited ${preview.email} to join ${preview.workspaceName} as ${ROLE_LABELS[preview.role].toLowerCase()}.`;
  const next = `/invite/${token}`;

  if (!user) {
    return (
      <AuthCard title={`Join ${preview.workspaceName}`} description={summary}>
        <p className="mb-4 text-sm text-muted-foreground">
          Sign in or create an account with {preview.email} to accept.
        </p>
        <div className="grid gap-2">
          <Button asChild>
            <Link href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/register?next=${encodeURIComponent(next)}`}>Create an account</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  if (user.email.toLowerCase() !== preview.email.toLowerCase()) {
    return (
      <AuthCard title={`Join ${preview.workspaceName}`} description={summary}>
        <p role="alert" className="mb-4 text-sm text-destructive">
          You are signed in as {user.email}, but this invitation is for {preview.email}. Sign out
          and open the link again with the right account.
        </p>
        <form action={logoutAction}>
          <Button type="submit" variant="outline" className="w-full">
            Sign out
          </Button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={`Join ${preview.workspaceName}`} description={summary}>
      <AcceptInviteForm token={token} />
    </AuthCard>
  );
}
