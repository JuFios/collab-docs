'use client';

import type { ThreadResponse } from '@collab-docs/shared';
import { Check, RotateCcw } from 'lucide-react';
import { forwardRef } from 'react';
import { Button } from '@/components/ui/button';
import { type NewComment, type Viewer, useReply, useSetResolved } from '@/lib/comments/queries';
import { isPending } from '@/lib/comments/threads';
import { cn } from '@/lib/utils';
import { CommentBody } from './comment-body';
import { CommentComposer } from './comment-composer';

const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * One thread: its comments, the resolve / reopen toggle and, for people who may comment, a reply box. A thread that
 * the api has not confirmed yet (`pending:` id) is shown dimmed and cannot be acted on.
 */
export const ThreadCard = forwardRef<
  HTMLLIElement,
  {
    thread: ThreadResponse;
    documentId: string;
    viewer: Viewer;
    canComment: boolean;
    active: boolean;
  }
>(function ThreadCard({ thread, documentId, viewer, canComment, active }, ref) {
  const reply = useReply(documentId, viewer);
  const setResolved = useSetResolved(documentId);
  const pending = isPending(thread);
  const headingId = `thread-${thread.id}`;

  function send(value: NewComment): Promise<boolean> {
    return reply.mutateAsync({ threadId: thread.id, ...value }).then(
      () => true,
      () => false,
    );
  }

  return (
    <li
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-busy={pending || undefined}
      data-testid="comment-thread"
      data-thread-id={thread.id}
      data-resolved={thread.resolved || undefined}
      className={cn(
        'grid gap-2 rounded-md border bg-background p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active && 'border-ring ring-1 ring-ring',
        thread.resolved && 'opacity-80',
        pending && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <h5 id={headingId} className="text-xs font-medium text-muted-foreground">
          {thread.resolved ? 'Resolved thread' : 'Thread'} · {thread.comments.length}{' '}
          {thread.comments.length === 1 ? 'comment' : 'comments'}
        </h5>
        {canComment && !pending ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2"
            disabled={setResolved.isPending}
            onClick={() => setResolved.mutate({ threadId: thread.id, resolved: !thread.resolved })}
          >
            {thread.resolved ? (
              <>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reopen
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5" aria-hidden /> Resolve
              </>
            )}
          </Button>
        ) : null}
      </div>
      <ol aria-label="Comments in this thread" className="grid gap-2">
        {thread.comments.map((comment) => (
          <li key={comment.id} className="grid gap-0.5">
            <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{comment.author.name}</span>
              <time dateTime={comment.createdAt}>
                {formatter.format(new Date(comment.createdAt))}
              </time>
              {comment.editedAt ? <span>(edited)</span> : null}
            </p>
            <CommentBody comment={comment} />
          </li>
        ))}
      </ol>
      {canComment && !thread.resolved && !pending ? (
        <CommentComposer
          documentId={documentId}
          label="Reply to this thread"
          submitLabel="Reply"
          placeholder="Reply…"
          onSubmit={send}
        />
      ) : null}
    </li>
  );
});
