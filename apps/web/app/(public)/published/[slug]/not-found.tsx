import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Page not available' };

export default function PublishedNotFound() {
  return (
    <main>
      <EmptyState
        headingLevel={1}
        title="This page is not available"
        description="It may have been unpublished, expired or removed."
      >
        <Button asChild variant="outline">
          <Link href="/">Go to Collab Docs</Link>
        </Button>
      </EmptyState>
    </main>
  );
}
