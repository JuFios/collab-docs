'use client';

import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';

// Server Component errors reach the boundary serialized (class lost), so only the digest is available as a reference.
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <ErrorState
        headingLevel={1}
        description="An unexpected error occurred while loading this page."
        correlationId={error.digest}
      >
        <Button onClick={reset} variant="outline">
          Try again
        </Button>
      </ErrorState>
    </main>
  );
}
