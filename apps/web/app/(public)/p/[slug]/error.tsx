'use client';

import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';

export default function PublishedError({
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
        description="This page could not be loaded right now. Try again in a moment."
        correlationId={error.digest}
      >
        <Button onClick={reset} variant="outline">
          Try again
        </Button>
      </ErrorState>
    </main>
  );
}
