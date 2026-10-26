'use client';

import { DocumentGone } from '@/components/documents/document-gone';
import { ErrorState, ForbiddenState } from '@/components/states';
import { Button } from '@/components/ui/button';
import type { CollabError } from '@/lib/collab/errors';

/** What replaces the editor when the session ended for good. */
export function CollabErrorState({
  error,
  workspaceId,
  documentId,
  member,
  onRetry,
}: {
  error: CollabError;
  workspaceId: string;
  documentId: string;
  member: boolean;
  onRetry: () => void;
}) {
  if (error.kind === 'forbidden') {
    return <ForbiddenState description={error.message} />;
  }
  if (error.kind === 'deleted' || error.kind === 'not-found') {
    return <DocumentGone workspaceId={workspaceId} documentId={documentId} member={member} />;
  }
  return (
    <ErrorState title="Could not connect" description={error.message}>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </ErrorState>
  );
}
