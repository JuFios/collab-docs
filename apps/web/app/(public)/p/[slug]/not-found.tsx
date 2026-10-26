import Link from 'next/link';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';

export default function PublishedNotFound() {
  return (
    <EmptyState
      title="This page is not available"
      description="It may have been unpublished, expired or removed."
    >
      <Button asChild variant="outline">
        <Link href="/">Go to Collab Docs</Link>
      </Button>
    </EmptyState>
  );
}
