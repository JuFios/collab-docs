'use client';

import { collabTicketSchema } from '@collab-docs/shared';
import Link from 'next/link';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { DocumentEditor } from '@/components/editor/document-editor';
import { PresenceAvatars } from '@/components/editor/presence-avatars';
import { SaveIndicator } from '@/components/editor/save-indicator';
import { Providers } from '@/components/providers';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { rejectionMessage } from '@/lib/collab/errors';
import { deriveSaveStatus } from '@/lib/collab/save-status';
import { useCollabConnection } from '@/lib/collab/use-collab-connection';
import { useOnlineStatus } from '@/lib/collab/use-online-status';
import { usePresence } from '@/lib/collab/use-presence';

/**
 * The editor for someone who opened an edit link: no account, no workspace chrome. The real-time connection is the
 * same hook as for members; only the ticket comes from the link, so the server checks the link again whenever the
 * socket is evaluated and a revoked link closes the session.
 */
export function GuestDocument(props: {
  token: string;
  documentId: string;
  title: string;
  expiresAt: string | null;
}) {
  // the editor shares its hooks with the app, which expect the query client
  return (
    <Providers>
      <GuestSession {...props} />
    </Providers>
  );
}

function GuestSession({
  token,
  documentId,
  title,
  expiresAt,
}: {
  token: string;
  documentId: string;
  title: string;
  expiresAt: string | null;
}) {
  const online = useOnlineStatus();
  const fetchTicket = useCallback(
    (signal: AbortSignal) =>
      apiClient.request(`/public/links/${encodeURIComponent(token)}/ticket`, {
        method: 'POST',
        schema: collabTicketSchema,
        signal,
      }),
    [token],
  );
  const connection = useCollabConnection(documentId, {
    fetchTicket,
    onRejected: ({ reason }) => toast.warning(rejectionMessage(reason)),
  });
  const presence = usePresence(connection.provider);
  const status = deriveSaveStatus({
    connection: connection.status,
    synced: connection.synced,
    hasUnsyncedChanges: connection.hasUnsyncedChanges,
    online,
    title: 'idle',
  });
  const editable = connection.accessLevel === null || connection.accessLevel === 'EDIT';

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-8">
      <article className="grid gap-4" aria-label={title || 'Untitled'}>
        <p className="text-sm text-muted-foreground">
          You are editing as a guest
          {expiresAt ? ` · the link works until ${new Date(expiresAt).toLocaleString()}` : ''}
        </p>
        <div className="flex items-center gap-2">
          <h1 className="min-w-0 truncate text-2xl font-semibold">{title || 'Untitled'}</h1>
          <SaveIndicator status={status} />
          <span className="ml-auto">
            <PresenceAvatars users={presence} />
          </span>
        </div>
        {connection.error ? (
          <GuestError kind={connection.error.kind} onRetry={connection.retry} />
        ) : connection.ydoc && connection.provider ? (
          <DocumentEditor
            key={connection.ydoc.guid}
            documentId={documentId}
            ydoc={connection.ydoc}
            provider={connection.provider}
            synced={connection.synced}
            editable={editable}
            images={false}
          />
        ) : (
          <LoadingState label="Opening the document…" />
        )}
      </article>
    </main>
  );
}

function GuestError({ kind, onRetry }: { kind: string; onRetry: () => void }) {
  if (kind === 'unavailable') {
    return (
      <ErrorState title="Could not connect" description="The real-time connection failed.">
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </ErrorState>
    );
  }
  const deleted = kind === 'deleted' || kind === 'not-found';
  return (
    <EmptyState
      title={deleted ? 'This document was deleted' : 'This link no longer works'}
      description={
        deleted
          ? 'The owner removed the document.'
          : 'It has expired or the owner turned it off. Anything you typed before is saved.'
      }
    >
      <Button asChild variant="outline">
        <Link href="/">Go to Collab Docs</Link>
      </Button>
    </EmptyState>
  );
}
