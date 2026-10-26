import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GuestDocument } from '@/components/public/guest-document';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { lookupEditLink } from '@/lib/public/edit-link';

// the address carries a secret: keep it out of search results, referrers and caches
export const metadata: Metadata = {
  title: 'Shared document · Collab Docs',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export const dynamic = 'force-dynamic';

function Unavailable({ title, description }: { title: string; description: string }) {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <EmptyState title={title} description={description}>
        <Button asChild variant="outline">
          <Link href="/">Go to Collab Docs</Link>
        </Button>
      </EmptyState>
    </main>
  );
}

export default async function EditLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lookup = await lookupEditLink(token);
  if (lookup.status === 'unknown') notFound();
  switch (lookup.status) {
    case 'expired':
      return (
        <Unavailable
          title="This link no longer works"
          description="It has expired or the owner turned it off. Ask them for a new link."
        />
      );
    case 'deleted':
      return (
        <Unavailable
          title="This document was deleted"
          description="The owner removed the document this link opened."
        />
      );
    case 'live':
      return (
        <GuestDocument
          token={token}
          documentId={lookup.link.documentId}
          title={lookup.link.title}
          expiresAt={lookup.link.expiresAt}
        />
      );
  }
}
