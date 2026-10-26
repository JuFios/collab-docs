import type { SnippetPart } from '@collab-docs/shared';

/** A snippet as text and `<mark>` elements: the parts are plain text, so nothing in them is ever parsed as markup. */
export function Snippet({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-sm bg-yellow-200 px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
