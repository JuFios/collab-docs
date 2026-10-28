'use client';

import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';

export default function EditLinkError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <ErrorState
        headingLevel={1}
        description="The shared document could not be opened right now."
        correlationId={error.digest}
      >
        <Button onClick={reset} variant="outline">
          Try again
        </Button>
      </ErrorState>
    </main>
  );
}
