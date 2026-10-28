'use client';

import { useDraggable } from '@dnd-kit/react';
import {
  DEFAULT_DOCUMENT_TITLE,
  accessAtLeast,
  roleAtLeast,
  type TreeNode,
  type WorkspaceRole,
} from '@collab-docs/shared';
import {
  ChevronRight,
  FilePlus2,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { DropZone } from '@/lib/documents/move';
import type { TreeRow } from '@/lib/documents/tree';
import { cn } from '@/lib/utils';

const INDENT_PX = 16;
const BASE_PADDING_PX = 4;

interface TreeRowProps {
  row: TreeRow;
  workspaceId: string;
  role: WorkspaceRole;
  active: boolean;
  tabbable: boolean;
  renaming: boolean;
  menuOpen: boolean;
  dropZone: DropZone | null;
  registerElement: (id: string, element: HTMLElement | null) => void;
  onToggle: (node: TreeNode) => void;
  onFocusRow: (node: TreeNode) => void;
  onRenameSubmit: (node: TreeNode, title: string) => void;
  onRenameCancel: () => void;
  onMenuOpenChange: (node: TreeNode, open: boolean) => void;
  onCreateChild: (node: TreeNode) => void;
  onStartRename: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
}

export function TreeRowItem(props: TreeRowProps) {
  const { row, workspaceId, role, active, tabbable, renaming, menuOpen, dropZone } = props;
  const { node } = row;
  const canEdit = accessAtLeast(node.myAccess, 'EDIT');
  const canCreate = canEdit && roleAtLeast(role, 'EDITOR');
  const { ref, handleRef, isDragSource } = useDraggable({ id: node.id, disabled: !canEdit });
  const elementRef = useRef<HTMLDivElement | null>(null);
  // the menu closes because the rename started, and it reads this when it does, after the render that started it
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const label = node.title || DEFAULT_DOCUMENT_TITLE;

  const setElement = (element: HTMLDivElement | null) => {
    elementRef.current = element;
    ref(element);
    props.registerElement(node.id, element);
  };

  const paddingLeft = BASE_PADDING_PX + row.depth * INDENT_PX;
  const indicatorLeft = BASE_PADDING_PX + (row.depth + (row.expanded ? 1 : 0)) * INDENT_PX;

  return (
    // The treeitem is focusable and carries the keyboard handling in DocumentTree (arrow keys, F2, Delete, Alt+arrows).
    <div
      ref={setElement}
      role="treeitem"
      tabIndex={tabbable ? 0 : -1}
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      aria-selected={active}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      aria-keyshortcuts={
        canEdit ? 'F2 Delete Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight' : undefined
      }
      data-node-id={node.id}
      data-drop-zone={dropZone ?? undefined}
      onFocus={(event) => {
        if (event.target === event.currentTarget) props.onFocusRow(node);
      }}
      className={cn(
        'group relative flex h-8 items-center rounded-md pr-1 text-sm outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-accent/60',
        isDragSource && 'opacity-60',
        dropZone === 'inside' && 'ring-2 ring-primary',
      )}
      style={{ paddingLeft }}
    >
      {dropZone === 'before' || dropZone === 'after' ? (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute right-1 z-10 h-0.5 rounded bg-primary',
            dropZone === 'before' ? '-top-px' : '-bottom-px',
          )}
          style={{ left: indicatorLeft }}
        />
      ) : null}

      {canEdit ? (
        <button
          ref={handleRef}
          type="button"
          tabIndex={-1}
          aria-label={`Drag ${label}`}
          className="flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : (
        <span className="w-4 shrink-0" aria-hidden />
      )}

      <button
        type="button"
        tabIndex={-1}
        aria-label={row.expanded ? `Collapse ${label}` : `Expand ${label}`}
        onClick={() => props.onToggle(node)}
        className={cn(
          'flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground',
          !row.hasChildren && 'invisible',
        )}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 transition-transform', row.expanded && 'rotate-90')}
          aria-hidden
        />
      </button>

      <span className="mr-1.5 shrink-0" aria-hidden>
        {node.icon ?? '📄'}
      </span>

      {renaming ? (
        <RenameInput
          initial={node.title}
          onSubmit={(title) => props.onRenameSubmit(node, title)}
          onCancel={props.onRenameCancel}
        />
      ) : (
        <Link
          href={`/workspaces/${workspaceId}/documents/${node.id}`}
          tabIndex={-1}
          draggable={false}
          className="min-w-0 flex-1 truncate py-1"
          title={label}
        >
          {label}
        </Link>
      )}

      {renaming ? null : (
        <span
          className={cn(
            'ml-auto flex shrink-0 items-center gap-0.5',
            !menuOpen && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}
        >
          {canCreate ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={`New subpage in ${label}`}
              onClick={() => props.onCreateChild(node)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
          {canEdit ? (
            <DropdownMenu
              open={menuOpen}
              onOpenChange={(open) => props.onMenuOpenChange(node, open)}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Actions for ${label}`}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(event) => {
                  // focus goes back to the row, not to the (hidden, untabbable) trigger; while the row is being
                  // renamed the title field has it, and taking it away would end the rename at once
                  event.preventDefault();
                  if (!renamingRef.current) elementRef.current?.focus();
                }}
              >
                {canCreate ? (
                  <DropdownMenuItem onSelect={() => props.onCreateChild(node)}>
                    <FilePlus2 className="h-4 w-4" aria-hidden /> New subpage
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={() => props.onStartRename(node)}>
                  <Pencil className="h-4 w-4" aria-hidden /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={() => props.onDelete(node)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden /> Move to trash
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </span>
      )}
    </div>
  );
}

function RenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onSubmit(value);
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // the tree's own key handling must not see typing
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };

  return (
    <input
      ref={input}
      value={value}
      maxLength={200}
      aria-label="Document title"
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      className="h-6 min-w-0 flex-1 rounded border border-input bg-background px-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
