'use client';

import { type DocumentDetails, accessAtLeast } from '@collab-docs/shared';
import { History, Link2, MessageSquare, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CommentsPanel } from '@/components/comments/comments-panel';
import { useCommentsUi } from '@/components/comments/use-comments-ui';
import { CollabErrorState } from '@/components/editor/collab-error-state';
import { DocumentEditor } from '@/components/editor/document-editor';
import { PresenceAvatars } from '@/components/editor/presence-avatars';
import { SaveIndicator } from '@/components/editor/save-indicator';
import { VersionsPanel } from '@/components/editor/versions-panel';
import { LoadingState } from '@/components/states';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { ShareDialog } from '@/components/sharing/share-dialog';
import { useOptionalWorkspace } from '@/components/workspaces/workspace-provider';
import { isApiError } from '@/lib/api/errors';
import type { Viewer } from '@/lib/comments/queries';
import { useDocumentQuery, useTree } from '@/lib/documents/queries';
import { descendantIds, pathTo } from '@/lib/documents/tree';
import { type TitleSaveState, deriveSaveStatus } from '@/lib/collab/save-status';
import { useCollabConnection } from '@/lib/collab/use-collab-connection';
import { useOnlineStatus } from '@/lib/collab/use-online-status';
import { usePresence } from '@/lib/collab/use-presence';
import { Breadcrumbs } from './breadcrumbs';
import { DeleteDocumentDialog } from './delete-document-dialog';
import { DocumentGone } from './document-gone';
import { DocumentTitle } from './document-title';
import { useDocumentActions } from './use-document-actions';

/**
 * The page around a document: breadcrumbs, title, presence, save status, actions and the editor. The page owns the
 * real-time connection (`useCollabConnection`) because the header and the editor both depend on it. A guest (not a
 * member, opened through a share) gets the same shell without the tree-dependent parts.
 */
export function DocumentShell({
  workspaceId,
  initial,
  viewer,
  initialThreadId = null,
}: {
  workspaceId: string;
  initial: DocumentDetails;
  viewer: Viewer;
  /** Thread to open on arrival (`?thread=` from a notification or an email). */
  initialThreadId?: string | null;
}) {
  const workspace = useOptionalWorkspace();
  const query = useDocumentQuery(initial.id, initial);

  if (query.error && isApiError(query.error) && query.error.status === 404) {
    return (
      <DocumentGone workspaceId={workspaceId} documentId={initial.id} member={workspace !== null} />
    );
  }
  if (query.isError && !query.data) {
    return <LoadingState label="Could not refresh the document" />;
  }
  const document = query.data ?? initial;
  return workspace ? (
    <MemberShell
      workspaceId={workspaceId}
      document={document}
      viewer={viewer}
      initialThreadId={initialThreadId}
    />
  ) : (
    <Frame
      workspaceId={workspaceId}
      document={document}
      trail={[]}
      menu={() => null}
      member={false}
      viewer={viewer}
      initialThreadId={initialThreadId}
    />
  );
}

function MemberShell({
  workspaceId,
  document,
  viewer,
  initialThreadId,
}: {
  workspaceId: string;
  document: DocumentDetails;
  viewer: Viewer;
  initialThreadId: string | null;
}) {
  const tree = useTree();
  const actions = useDocumentActions();
  const [confirming, setConfirming] = useState(false);
  const nodes = tree.data ?? [];
  const trail = pathTo(nodes, document.id);
  const canDelete = accessAtLeast(document.myAccess, 'EDIT');

  return (
    <>
      <Frame
        workspaceId={workspaceId}
        document={document}
        trail={trail}
        member
        viewer={viewer}
        initialThreadId={initialThreadId}
        menu={(focusTitle) =>
          canDelete ? (
            <DocumentMenu
              document={document}
              onRename={focusTitle}
              onTrash={() => setConfirming(true)}
            />
          ) : null
        }
      />
      <DeleteDocumentDialog
        title={document.title}
        subpages={descendantIds(nodes, document.id).length}
        open={confirming}
        pending={actions.deleting}
        onOpenChange={setConfirming}
        onConfirm={() =>
          void actions.deleteDocument(document).then((ok) => {
            if (ok) setConfirming(false);
          })
        }
      />
    </>
  );
}

function DocumentMenu({
  document,
  onRename,
  onTrash,
}: {
  document: DocumentDetails;
  onRename: () => void;
  onTrash: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Document actions">
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            void navigator.clipboard
              ?.writeText(
                `${window.location.origin}/workspaces/${document.workspaceId}/documents/${document.id}`,
              )
              .then(() => toast.success('Link copied'))
              .catch(() => toast.error('Could not copy the link'));
          }}
        >
          <Link2 className="h-4 w-4" aria-hidden /> Copy link
        </DropdownMenuItem>
        <DropdownMenuItem
          // the menu returns focus to its trigger when it closes; focus the field after that
          onSelect={() => setTimeout(onRename, 0)}
        >
          <Pencil className="h-4 w-4" aria-hidden /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem className="text-destructive" onSelect={onTrash}>
          <Trash2 className="h-4 w-4" aria-hidden /> Move to trash
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Frame({
  workspaceId,
  document,
  trail,
  menu,
  member,
  viewer,
  initialThreadId,
}: {
  workspaceId: string;
  document: DocumentDetails;
  trail: ReturnType<typeof pathTo>;
  menu: (focusTitle: () => void) => React.ReactNode;
  member: boolean;
  viewer: Viewer;
  initialThreadId: string | null;
}) {
  const titleField = useRef<HTMLInputElement>(null);
  const [saveState, setSaveState] = useState<TitleSaveState>('idle');
  const [sidePanel, setSidePanel] = useState<'history' | 'comments' | null>(null);
  const commentsToggle = useRef<HTMLButtonElement>(null);
  const openComments = useCallback(() => setSidePanel('comments'), []);
  const online = useOnlineStatus();
  const connection = useCollabConnection(document.id, {
    onDowngrade: ({ discardedChanges }) =>
      toast.warning(
        discardedChanges
          ? 'Your access changed to read-only. Edits that were not saved were discarded.'
          : 'Your access changed to read-only.',
      ),
  });
  const presence = usePresence(connection.provider);
  // the REST answer decides until the server reports the live level on connect
  const accessLevel = connection.accessLevel ?? document.myAccess;
  const editable = accessAtLeast(accessLevel, 'EDIT');
  const canComment = accessAtLeast(accessLevel, 'COMMENT');
  const comments = useCommentsUi({
    documentId: document.id,
    canComment,
    initialThreadId,
    openPanel: openComments,
  });
  const status = deriveSaveStatus({
    connection: connection.status,
    synced: connection.synced,
    hasUnsyncedChanges: connection.hasUnsyncedChanges,
    online,
    title: saveState,
  });
  // a reader has nothing to save; only the connection problems matter to them
  const showStatus = editable || status === 'offline' || status === 'connecting';
  const unsaved = editable && connection.hasUnsyncedChanges;

  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  if (connection.error && connection.error.kind !== 'unavailable') {
    return (
      <CollabErrorState
        error={connection.error}
        workspaceId={workspaceId}
        documentId={document.id}
        member={member}
        onRetry={connection.retry}
      />
    );
  }

  return (
    <article
      className="grid grid-cols-[minmax(0,1fr)] gap-4"
      aria-label={document.title || 'Untitled'}
    >
      {member ? (
        <Breadcrumbs workspaceId={workspaceId} path={trail} current={document.title} />
      ) : (
        <p className="text-sm text-muted-foreground">Shared with you</p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden className="text-2xl">
          {document.icon ?? '📄'}
        </span>
        <DocumentTitle
          workspaceId={workspaceId}
          document={document}
          editable={editable}
          inputRef={titleField}
          onSaveState={setSaveState}
        />
        {editable ? null : (
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            Read-only
          </span>
        )}
        {showStatus ? <SaveIndicator status={status} /> : null}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <PresenceAvatars users={presence} />
          {member ? (
            <ShareDialog
              document={document}
              sync={{
                online,
                synced: connection.synced,
                hasUnsyncedChanges: connection.hasUnsyncedChanges,
              }}
            />
          ) : null}
          <Button
            ref={commentsToggle}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={sidePanel === 'comments'}
            onClick={() => setSidePanel((open) => (open === 'comments' ? null : 'comments'))}
          >
            <MessageSquare className="h-4 w-4" aria-hidden /> Comments
            {comments.openCount > 0 ? ` (${comments.openCount})` : ''}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={sidePanel === 'history'}
            onClick={() => setSidePanel((open) => (open === 'history' ? null : 'history'))}
          >
            <History className="h-4 w-4" aria-hidden /> History
          </Button>
          {menu(() => {
            titleField.current?.focus();
            titleField.current?.select();
          })}
        </span>
      </div>
      <div className={sidePanel ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]' : 'grid gap-4'}>
        <div className="min-w-0">
          {connection.error ? (
            <CollabErrorState
              error={connection.error}
              workspaceId={workspaceId}
              documentId={document.id}
              member={member}
              onRetry={connection.retry}
            />
          ) : connection.ydoc && connection.provider ? (
            <DocumentEditor
              key={connection.ydoc.guid}
              documentId={document.id}
              ydoc={connection.ydoc}
              provider={connection.provider}
              synced={connection.synced}
              editable={editable}
              blockComments={comments.controller}
              onEditor={comments.setEditor}
            />
          ) : (
            <LoadingState label="Opening the document…" />
          )}
        </div>
        {sidePanel === 'history' ? (
          <VersionsPanel
            documentId={document.id}
            canEdit={editable}
            onClose={() => setSidePanel(null)}
          />
        ) : null}
        {sidePanel === 'comments' ? (
          <CommentsPanel
            documentId={document.id}
            viewer={viewer}
            canComment={canComment}
            editor={comments.editor}
            composeBlockId={comments.composeBlockId}
            onComposeEnd={comments.endCompose}
            activeThreadId={comments.activeThreadId}
            onSelectThread={comments.select}
            onClose={() => {
              comments.endCompose();
              setSidePanel(null);
              // the panel held the focus; hand it back to the button that opened it
              requestAnimationFrame(() => commentsToggle.current?.focus());
            }}
          />
        ) : null}
      </div>
    </article>
  );
}
