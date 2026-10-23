'use client';

import { type DocumentDetails, accessAtLeast } from '@collab-docs/shared';
import { Link2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { LoadingState } from '@/components/states';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useOptionalWorkspace } from '@/components/workspaces/workspace-provider';
import { isApiError } from '@/lib/api/errors';
import { useDocumentQuery, useTree } from '@/lib/documents/queries';
import { descendantIds, pathTo } from '@/lib/documents/tree';
import { Breadcrumbs } from './breadcrumbs';
import { DeleteDocumentDialog } from './delete-document-dialog';
import { DocumentGone } from './document-gone';
import { DocumentTitle, type TitleSaveState } from './document-title';
import { useDocumentActions } from './use-document-actions';

const SAVE_LABELS: Record<TitleSaveState, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Could not save',
};

/**
 * The page around a document: breadcrumbs, title, actions and the state banners. The editor itself is not part of
 * this shell yet; `data-testid="editor-placeholder"` marks where it mounts. A guest (not a member, opened through a
 * share) gets the same shell without the tree-dependent parts.
 */
export function DocumentShell({
  workspaceId,
  initial,
}: {
  workspaceId: string;
  initial: DocumentDetails;
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
    <MemberShell workspaceId={workspaceId} document={document} />
  ) : (
    <Frame
      workspaceId={workspaceId}
      document={document}
      trail={[]}
      menu={() => null}
      member={false}
    />
  );
}

function MemberShell({
  workspaceId,
  document,
}: {
  workspaceId: string;
  document: DocumentDetails;
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
              ?.writeText(`${window.location.origin}/w/${document.workspaceId}/d/${document.id}`)
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
}: {
  workspaceId: string;
  document: DocumentDetails;
  trail: ReturnType<typeof pathTo>;
  menu: (focusTitle: () => void) => React.ReactNode;
  member: boolean;
}) {
  const editable = accessAtLeast(document.myAccess, 'EDIT');
  const titleField = useRef<HTMLInputElement>(null);
  const [saveState, setSaveState] = useState<TitleSaveState>('idle');

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
      <div className="flex items-center gap-2">
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
        <span role="status" aria-live="polite" className="shrink-0 text-xs text-muted-foreground">
          {SAVE_LABELS[saveState]}
        </span>
        {menu(() => {
          titleField.current?.focus();
          titleField.current?.select();
        })}
      </div>
      <div
        data-testid="editor-placeholder"
        className="grid min-h-64 place-items-center rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground"
      >
        The document editor is not available yet. Title, structure and sharing already work.
      </div>
    </article>
  );
}
