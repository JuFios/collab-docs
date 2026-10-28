import { LINK_PROTOCOLS, LINK_REL } from '@collab-docs/shared/content';
import type { ReactNode } from 'react';

/**
 * Renders sanitised document JSON (what `GET /documents/:id/versions/:versionId` and the public endpoints return).
 * Deliberately not a Client Component: it has no state, so the public page can render it on the server without
 * shipping it to the browser. Images are resolved by the caller (`resolveImageSrc`), because the editor reads them
 * through signed URLs and the public page through `/media/:id`.
 *
 * The input is expected to be sanitised already; links are checked again here because a link is the one element
 * where a mistake upstream would become script execution.
 */
interface ContentRendererProps {
  content: { type: 'doc'; content?: unknown[] } | null | undefined;
  resolveImageSrc?: (attachmentId: string) => string | undefined;
  className?: string;
}

interface RawNode {
  type?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown;
  marks?: unknown;
  text?: unknown;
}

interface RenderContext {
  resolveImageSrc?: (attachmentId: string) => string | undefined;
}

const isNode = (value: unknown): value is RawNode => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function safeHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return (LINK_PROTOCOLS as readonly string[]).includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function renderMarks(node: RawNode, inner: ReactNode): ReactNode {
  const marks = Array.isArray(node.marks) ? node.marks : [];
  return marks.reduce<ReactNode>((wrapped, mark) => {
    if (!isNode(mark)) return wrapped;
    switch (mark.type) {
      case 'bold':
        return <strong>{wrapped}</strong>;
      case 'italic':
        return <em>{wrapped}</em>;
      case 'code':
        return (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{wrapped}</code>
        );
      case 'link': {
        const href = safeHref(mark.attrs?.href);
        return href ? (
          <a href={href} rel={LINK_REL} className="text-primary underline underline-offset-2">
            {wrapped}
          </a>
        ) : (
          wrapped
        );
      }
      default:
        return wrapped;
    }
  }, inner);
}

function renderChildren(node: RawNode, context: RenderContext): ReactNode {
  const children = Array.isArray(node.content) ? node.content : [];
  return children.map((child, index) => renderNode(child, index, context));
}

function renderNode(value: unknown, key: number, context: RenderContext): ReactNode {
  if (!isNode(value)) return null;
  const blockId = typeof value.attrs?.id === 'string' ? value.attrs.id : undefined;
  switch (value.type) {
    case 'text':
      return <span key={key}>{renderMarks(value, text(value.text))}</span>;
    case 'paragraph':
      return (
        <p key={key} data-block-id={blockId}>
          {renderChildren(value, context)}
        </p>
      );
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(value.attrs?.level) || 1));
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3';
      return (
        <Tag key={key} data-block-id={blockId}>
          {renderChildren(value, context)}
        </Tag>
      );
    }
    case 'bulletList':
      return (
        <ul key={key} data-block-id={blockId}>
          {renderChildren(value, context)}
        </ul>
      );
    case 'orderedList':
      return (
        <ol key={key} data-block-id={blockId} start={Number(value.attrs?.start) || 1}>
          {renderChildren(value, context)}
        </ol>
      );
    case 'listItem':
      return <li key={key}>{renderChildren(value, context)}</li>;
    case 'taskList':
      return (
        <ul key={key} data-block-id={blockId} data-type="taskList" className="list-none pl-0">
          {renderChildren(value, context)}
        </ul>
      );
    case 'taskItem':
      return (
        <li key={key} className="flex items-start gap-2">
          <input
            type="checkbox"
            disabled
            readOnly
            checked={value.attrs?.checked === true}
            aria-label="Task"
            className="mt-1.5"
          />
          <div>{renderChildren(value, context)}</div>
        </li>
      );
    case 'codeBlock': {
      const language = typeof value.attrs?.language === 'string' ? value.attrs.language : undefined;
      return (
        <pre
          key={key}
          data-block-id={blockId}
          className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-sm"
        >
          <code data-language={language}>{renderChildren(value, context)}</code>
        </pre>
      );
    }
    case 'image': {
      const attachmentId = text(value.attrs?.attachmentId);
      const src = attachmentId ? context.resolveImageSrc?.(attachmentId) : undefined;
      return (
        <figure key={key} data-block-id={blockId}>
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed or proxied URL chosen by the caller
            <img src={src} alt={text(value.attrs?.alt)} className="max-w-full rounded-md" />
          ) : (
            <div
              role="img"
              aria-label={text(value.attrs?.alt) || 'Image'}
              className="h-24 w-48 rounded-md border border-dashed bg-muted"
            />
          )}
        </figure>
      );
    }
    case 'hardBreak':
      return <br key={key} />;
    case 'mention':
      return (
        <span key={key} className="rounded bg-accent px-1">
          @{text(value.attrs?.label)}
        </span>
      );
    default:
      return null;
  }
}

export function ContentRenderer({ content, resolveImageSrc, className }: ContentRendererProps) {
  return (
    <div className={className}>
      {Array.isArray(content?.content)
        ? content.content.map((node, index) => renderNode(node, index, { resolveImageSrc }))
        : null}
    </div>
  );
}

/** Attachment ids of the image blocks in `content`, in document order (for resolving them in one go). */
export function collectImageIds(content: { content?: unknown[] } | null | undefined): string[] {
  const ids: string[] = [];
  const visit = (value: unknown) => {
    if (!isNode(value)) return;
    if (value.type === 'image' && typeof value.attrs?.attachmentId === 'string') {
      ids.push(value.attrs.attachmentId);
    }
    if (Array.isArray(value.content)) value.content.forEach(visit);
  };
  content?.content?.forEach(visit);
  return ids;
}
