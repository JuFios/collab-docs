'use client';

import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';

// Error boundaries must be Client Components; this one keeps the navbar and workspace header when a page fails.
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorState description="This workspace page could not be loaded." correlationId={error.digest}>
      <Button onClick={reset} variant="outline">
        Try again
      </Button>
    </ErrorState>
  );
}
