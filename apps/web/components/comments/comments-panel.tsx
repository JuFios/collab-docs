'use client';

import type { ThreadResponse } from '@collab-docs/shared';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { MessageSquare, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { type NewComment, type Viewer, useCreateThread, useThreads } from '@/lib/comments/queries';
import { groupThreads } from '@/lib/comments/threads';
import { blockLabels } from './block-labels';
import { CommentComposer } from './comment-composer';
import { ThreadCard } from './thread-card';

const NO_LABELS: Record<string, string> = {};

/**
 * Comments beside the editor: threads grouped by the block they are about (a click on the block's name scrolls to
 * it), a "show resolved" switch, threads whose block was deleted in a section of their own, and a composer for the
 * thread that is being started. Readers see everything but get no composer.
 */
export function CommentsPanel({
  documentId,
  viewer,
  canComment,
  editor,
  composeBlockId,
  onComposeEnd,
  activeThreadId,
  onSelectThread,
  onClose,
}: {
  documentId: string;
  viewer: Viewer;
  canComment: boolean;
  /** `null` while the editor is not there (loading, error): blocks then cannot be named or scrolled to. */
  editor: Editor | null;
  /** The block a new thread is being written for. */
  composeBlockId: string | null;
  onComposeEnd: () => void;
  activeThreadId: string | null;
  onSelectThread: (thread: ThreadResponse) => void;
  onClose: () => void;
}) {
  const threads = useThreads(documentId);
  const createThread = useCreateThread(documentId, viewer);
  const [showResolved, setShowResolved] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const cards = useRef(new Map<string, HTMLLIElement>());
  const switchId = useId();

  const active = threads.data?.find((thread) => thread.id === activeThreadId);
  // a thread that was opened from a link or the editor must be visible, resolved or not
  const includeResolved = showResolved || active?.resolved === true;
  const { blocks, orphaned } = useMemo(
    () => groupThreads(threads.data ?? [], includeResolved),
    [threads.data, includeResolved],
  );
  const openCount = threads.data?.filter((thread) => !thread.resolved).length ?? 0;
  const wanted = useMemo(
    () =>
      new Set([
        ...blocks.map((group) => group.blockId),
        ...(composeBlockId ? [composeBlockId] : []),
      ]),
    [blocks, composeBlockId],
  );
  const labels =
    useEditorState({
      editor,
      selector: ({ editor: current }) =>
        current ? blockLabels(current.state.doc, wanted) : NO_LABELS,
    }) ?? NO_LABELS;

  // the panel is where keyboard users continue after opening it; a thread that is about to be written has its own focus
  const openedForCompose = useRef(composeBlockId !== null);
  useEffect(() => {
    if (!openedForCompose.current) heading.current?.focus();
  }, []);

  useEffect(() => {
    if (activeThreadId) cards.current.get(activeThreadId)?.scrollIntoView({ block: 'nearest' });
  }, [activeThreadId, threads.data]);

  function startThread(value: NewComment): Promise<boolean> {
    if (!composeBlockId) return Promise.resolve(false);
    return createThread.mutateAsync({ blockId: composeBlockId, ...value }).then(
      () => {
        onComposeEnd();
        heading.current?.focus();
        return true;
      },
      () => false,
    );
  }

  const nothing = threads.data !== undefined && blocks.length === 0 && orphaned.length === 0;

  return (
    <aside
      aria-label="Comments"
      data-testid="comments-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) onClose();
      }}
      className="grid content-start gap-3 rounded-lg border bg-card p-3 text-sm lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto"
    >
      <div className="flex items-center gap-2">
        <MessageSquare className="h-4 w-4" aria-hidden />
        <h3 ref={heading} tabIndex={-1} className="font-semibold focus-visible:outline-none">
          Comments{openCount > 0 ? ` (${openCount} open)` : ''}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close comments"
          className="ml-auto h-7 w-7"
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <input
          id={switchId}
          type="checkbox"
          checked={showResolved}
          onChange={(event) => setShowResolved(event.target.checked)}
          className="h-4 w-4"
        />
        <label htmlFor={switchId} className="text-muted-foreground">
          Show resolved threads
        </label>
      </div>

      {!canComment ? (
        <p
          className="rounded-md bg-muted px-3 py-2 text-muted-foreground"
          data-testid="comments-readonly"
        >
          You can read comments, but you need comment access to this document to write them.
        </p>
      ) : null}

      {composeBlockId ? (
        <section aria-label="New thread" className="grid gap-2 rounded-md border border-ring p-2">
          <p className="text-xs text-muted-foreground">
            New thread on{' '}
            <span className="font-medium text-foreground">
              {labels[composeBlockId] ?? 'this block'}
            </span>
          </p>
          <CommentComposer
            documentId={documentId}
            label="New comment"
            autoFocus
            onSubmit={startThread}
            onCancel={() => {
              onComposeEnd();
              heading.current?.focus();
            }}
          />
        </section>
      ) : null}

      {threads.isPending ? <LoadingState label="Loading comments…" /> : null}
      {threads.isError ? (
        <div role="alert" className="grid gap-2">
          <p className="text-destructive">Could not load the comments.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void threads.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {nothing ? (
        <p className="text-muted-foreground">
          {threads.data?.length
            ? 'No open threads. Turn on “Show resolved threads” to see the closed ones.'
            : canComment
              ? 'No comments yet. Use the comment button beside a block to start a thread.'
              : 'No comments yet.'}
        </p>
      ) : null}

      {blocks.map((group) => (
        <section
          key={group.blockId}
          aria-label={`Comments on ${labels[group.blockId] ?? 'a block'}`}
          className="grid gap-2"
        >
          <h4>
            <button
              type="button"
              title="Show in the document"
              onClick={() => onSelectThread(group.threads[0]!)}
              className="w-full truncate rounded-sm text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              “{labels[group.blockId] ?? 'Block'}”
            </button>
          </h4>
          <ul className="grid gap-2">
            {group.threads.map((thread) => (
              <ThreadCard
                key={thread.id}
                ref={(element) => {
                  if (element) cards.current.set(thread.id, element);
                  else cards.current.delete(thread.id);
                }}
                thread={thread}
                documentId={documentId}
                viewer={viewer}
                canComment={canComment}
                active={thread.id === activeThreadId}
              />
            ))}
          </ul>
        </section>
      ))}

      {orphaned.length > 0 ? (
        <section aria-label="Comments on deleted blocks" className="grid gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">Deleted blocks</h4>
          <p className="text-xs text-muted-foreground">
            The text these threads were about has been removed from the document.
          </p>
          <ul className="grid gap-2">
            {orphaned.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                documentId={documentId}
                viewer={viewer}
                canComment={canComment}
                active={thread.id === activeThreadId}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}
