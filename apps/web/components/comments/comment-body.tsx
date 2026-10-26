import type { CommentResponse } from '@collab-docs/shared';
import { splitBody } from '@/lib/comments/mentions';

/**
 * A comment's text. It is rendered as React text nodes only, so markup typed into a comment (an `<img onerror>`, a
 * `<script>`) is shown literally and never interpreted. A mention token becomes `@Name` for users the api listed.
 */
export function CommentBody({ comment }: { comment: CommentResponse }) {
  if (comment.deleted) {
    return <p className="text-sm italic text-muted-foreground">This comment was deleted.</p>;
  }
  return (
    <p className="whitespace-pre-wrap break-words text-sm" data-testid="comment-body">
      {splitBody(comment.body, comment.mentions).map((part, index) =>
        part.type === 'text' ? (
          part.text
        ) : (
          <span
            key={`${part.userId}-${index}`}
            className="rounded bg-accent px-1 font-medium text-accent-foreground"
          >
            @{part.name}
          </span>
        ),
      )}
    </p>
  );
}
