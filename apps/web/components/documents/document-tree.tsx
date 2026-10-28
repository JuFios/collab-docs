'use client';

import { DragDropProvider, PointerSensor } from '@dnd-kit/react';
import { type TreeNode, roleAtLeast } from '@collab-docs/shared';
import { Plus } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/components/workspaces/workspace-provider';
import { useExpandedState } from '@/lib/documents/expanded-state';
import {
  type DropZone,
  type KeyboardMove,
  type MovePlan,
  type RowRect,
  locateDrop,
  pointerYOf,
  planDrop,
  planKeyboardMove,
} from '@/lib/documents/move';
import { useMoveDocument, useSaveDocumentTitle, useTree } from '@/lib/documents/queries';
import { ancestorIds, descendantIds, flattenVisible } from '@/lib/documents/tree';
import { ConnectionBadge } from './connection-badge';
import { DeleteDocumentDialog } from './delete-document-dialog';
import { TreeRowItem } from './tree-row';
import { TreeSkeleton } from './tree-skeleton';
import { useDocumentActions } from './use-document-actions';
import { useRefreshListings } from './use-refresh-listings';

interface DropTarget {
  overId: string;
  zone: DropZone;
  plan: MovePlan;
}

const ALT_MOVES: Record<string, KeyboardMove> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowRight: 'indent',
  ArrowLeft: 'outdent',
};

/**
 * The workspace navigation tree: one flat list from the api rendered as nested rows. Drag and drop uses the
 * pointer; the keyboard has the ARIA tree keys plus Alt+Arrow to reorder, indent and outdent. Both end in the same
 * `MovePlan`, computed by pure functions in `lib/documents/move`, and in one optimistic `move` mutation.
 */
export function DocumentTree() {
  const { workspaceId, role } = useWorkspace();
  const params = useParams<{ documentId?: string }>();
  const activeId = params.documentId;
  const router = useRouter();
  const tree = useTree();
  const nodes = tree.data;

  const forced = useMemo(
    () => (activeId && nodes ? ancestorIds(nodes, activeId) : []),
    [activeId, nodes],
  );
  const { expanded, toggle, expand, collapse } = useExpandedState(workspaceId, forced);
  const rows = useMemo(() => flattenVisible(nodes ?? [], expanded), [nodes, expanded]);

  const actions = useDocumentActions(expand);
  const move = useMoveDocument(workspaceId);
  const rename = useSaveDocumentTitle(workspaceId);
  const refreshListings = useRefreshListings();

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TreeNode | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const refocus = useRef<string | null>(null);
  const deleteOrigin = useRef<HTMLElement | null>(null);

  const canCreate = roleAtLeast(role, 'EDITOR');
  const tabbableId =
    (focusedId && rows.some((row) => row.node.id === focusedId) ? focusedId : null) ??
    (activeId && rows.some((row) => row.node.id === activeId) ? activeId : null) ??
    rows[0]?.node.id ??
    null;

  useEffect(() => {
    if (!refocus.current) return;
    elements.current.get(refocus.current)?.focus();
    refocus.current = null;
  });

  const registerElement = useCallback((id: string, element: HTMLElement | null) => {
    if (element) elements.current.set(id, element);
    else elements.current.delete(id);
  }, []);

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    elements.current.get(id)?.focus();
  };

  const runMove = (id: string, plan: MovePlan) => {
    refocus.current = id;
    if (plan.parentId) expand(plan.parentId);
    move.mutate({ id, plan });
  };

  const commitRename = (node: TreeNode, title: string) => {
    setRenamingId(null);
    refocus.current = node.id;
    const next = title.trim();
    if (next !== node.title)
      rename.mutate({ id: node.id, title: next }, { onSuccess: refreshListings });
  };

  const askToDelete = (node: TreeNode) => {
    // the dialog has no trigger of its own, so it is told where focus goes when it closes
    deleteOrigin.current = elements.current.get(node.id) ?? null;
    setMenuId(null);
    setDeleting(node);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const node = deleting;
    if (await actions.deleteDocument(node)) setDeleting(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('[role="treeitem"]');
    // typing in the rename field and keys from menus/dialogs (portals bubble through React) are not ours
    if (!item || item !== target) return;
    const index = rows.findIndex((row) => row.node.id === item.dataset.nodeId);
    const row = rows[index];
    if (!row) return;
    const { node } = row;
    const canEdit = node.myAccess === 'EDIT' || node.myAccess === 'MANAGE';

    if (event.altKey && ALT_MOVES[event.key]) {
      event.preventDefault();
      if (!canEdit) return;
      const plan = planKeyboardMove(nodes ?? [], node.id, ALT_MOVES[event.key] as KeyboardMove);
      if (plan) runMove(node.id, plan);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(rows[index + 1]?.node.id);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(rows[index - 1]?.node.id);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(rows[0]?.node.id);
        break;
      case 'End':
        event.preventDefault();
        focusRow(rows[rows.length - 1]?.node.id);
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (row.hasChildren && !row.expanded) expand(node.id);
        else if (row.expanded) focusRow(rows[index + 1]?.node.id);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (row.expanded) collapse(node.id);
        else focusRow(node.parentId ?? undefined);
        break;
      case 'Enter':
        event.preventDefault();
        router.push(`/workspaces/${workspaceId}/documents/${node.id}`);
        break;
      case 'F2':
        event.preventDefault();
        if (canEdit) setRenamingId(node.id);
        break;
      case 'Delete':
        event.preventDefault();
        if (canEdit) askToDelete(node);
        break;
      case 'ContextMenu':
        event.preventDefault();
        if (canEdit) setMenuId(node.id);
        break;
      case 'F10':
        if (event.shiftKey && canEdit) {
          event.preventDefault();
          setMenuId(node.id);
        }
        break;
    }
  };

  const measure = (draggedId: string): RowRect[] =>
    rows
      .filter((row) => row.node.id !== draggedId)
      .flatMap((row) => {
        const element = elements.current.get(row.node.id);
        if (!element) return [];
        const rect = element.getBoundingClientRect();
        return [{ id: row.node.id, top: rect.top, height: rect.height }];
      });

  const updateDropTarget = (draggedId: string, pointerY: number) => {
    const located = locateDrop(measure(draggedId), pointerY);
    const plan = located
      ? planDrop(nodes ?? [], expanded, draggedId, located.overId, located.zone)
      : null;
    const next = located && plan ? { overId: located.overId, zone: located.zone, plan } : null;
    const previous = dropTargetRef.current;
    if (previous?.overId === next?.overId && previous?.zone === next?.zone) return;
    dropTargetRef.current = next;
    setDropTarget(next);
  };

  const header = (
    <div className="flex items-center justify-between gap-2 px-1 pb-2">
      <h2 className="text-sm font-semibold">Documents</h2>
      <div className="flex items-center gap-2">
        <ConnectionBadge />
        {canCreate ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label="New document"
            disabled={actions.creating}
            onClick={() => void actions.createDocument()}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </Button>
        ) : null}
      </div>
    </div>
  );

  if (!nodes) {
    return (
      <div>
        {header}
        {tree.isError ? (
          <div className="grid gap-2 px-2 py-4 text-center text-sm text-muted-foreground">
            <p>The document tree failed to load.</p>
            <Button variant="outline" size="sm" onClick={() => void tree.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <TreeSkeleton />
        )}
      </div>
    );
  }

  const deletingSubpages = deleting ? descendantIds(nodes, deleting.id).length : 0;

  return (
    <div>
      {header}
      {rows.length === 0 ? (
        <div className="grid gap-2 px-2 py-6 text-center text-sm text-muted-foreground">
          <p>
            {canCreate ? 'The workspace is empty.' : 'Nothing has been shared with you here yet.'}
          </p>
          {canCreate ? (
            <Button
              variant="outline"
              size="sm"
              disabled={actions.creating}
              onClick={() => void actions.createDocument()}
            >
              Create the first document
            </Button>
          ) : null}
        </div>
      ) : (
        <DragDropProvider
          // pointer only: the keyboard has Alt+Arrow, which needs no pointer geometry
          sensors={[PointerSensor]}
          onDragMove={(event) => {
            const source = event.operation.source;
            if (!source) return;
            updateDropTarget(
              String(source.id),
              pointerYOf({
                currentY: event.operation.position.current.y,
                to: event.to,
                by: event.by,
              }),
            );
          }}
          onDragEnd={(event) => {
            const source = event.operation.source;
            const target = dropTargetRef.current;
            dropTargetRef.current = null;
            setDropTarget(null);
            if (event.canceled || !source || !target) return;
            runMove(String(source.id), target.plan);
          }}
        >
          <div
            role="tree"
            aria-label="Documents"
            aria-multiselectable={false}
            onKeyDown={onKeyDown}
            className="grid gap-px"
          >
            {rows.map((row) => (
              <TreeRowItem
                key={row.node.id}
                row={row}
                workspaceId={workspaceId}
                role={role}
                active={row.node.id === activeId}
                tabbable={row.node.id === tabbableId}
                renaming={renamingId === row.node.id}
                menuOpen={menuId === row.node.id}
                dropZone={dropTarget?.overId === row.node.id ? dropTarget.zone : null}
                registerElement={registerElement}
                onToggle={(node) => toggle(node.id)}
                onFocusRow={(node) => setFocusedId(node.id)}
                onRenameSubmit={commitRename}
                onRenameCancel={() => {
                  refocus.current = renamingId;
                  setRenamingId(null);
                }}
                onMenuOpenChange={(node, open) => setMenuId(open ? node.id : null)}
                onCreateChild={(node) => void actions.createDocument(node.id)}
                onStartRename={(node) => {
                  setMenuId(null);
                  setRenamingId(node.id);
                }}
                onDelete={askToDelete}
              />
            ))}
          </div>
        </DragDropProvider>
      )}
      <DeleteDocumentDialog
        title={deleting?.title ?? ''}
        subpages={deletingSubpages}
        open={deleting !== null}
        pending={actions.deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        returnFocusTo={deleteOrigin}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
