import type { ContentNode } from './types';

/** Reads tolerate unsanitised input: anything that is not a node is skipped. */
const nodesOf = (node: ContentNode): ContentNode[] =>
  Array.isArray(node.content)
    ? node.content.filter((child) => typeof child === 'object' && child !== null)
    : [];

const INLINE_TYPES = new Set(['text', 'hardBreak', 'mention']);

function inlineText(node: ContentNode): string {
  switch (node.type) {
    case 'text':
      return typeof node.text === 'string' ? node.text : '';
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const label = node.attrs?.label;
      return typeof label === 'string' && label ? `@${label}` : '';
    }
    default:
      return nodesOf(node).map(inlineText).join('');
  }
}

function collectLines(node: ContentNode, lines: string[]): void {
  const children = nodesOf(node);
  if (children.length > 0 && children.every((child) => INLINE_TYPES.has(child.type))) {
    lines.push(children.map(inlineText).join(''));
    return;
  }
  for (const child of children) collectLines(child, lines);
}

/** Text of the document for search indexing and descriptions: one line per block, list items on their own lines. */
export function extractPlainText(doc: ContentNode): string {
  const lines: string[] = [];
  collectLines(doc, lines);
  return lines.join('\n').trim();
}

export interface ContentMeta {
  /** First text of the document, whitespace collapsed, at most 160 characters. */
  description: string;
  /** Attachment of the first image (Open Graph preview), if any. */
  firstImageAttachmentId: string | null;
}

export const DESCRIPTION_MAX_LENGTH = 160;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // prefer a word boundary unless it would throw away most of the text
  const base = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

function walk(node: ContentNode, visit: (node: ContentNode) => void): void {
  visit(node);
  for (const child of nodesOf(node)) walk(child, visit);
}

export function extractMeta(doc: ContentNode): ContentMeta {
  const description = truncate(
    extractPlainText(doc).replace(/\s+/g, ' ').trim(),
    DESCRIPTION_MAX_LENGTH,
  );
  let firstImageAttachmentId: string | null = null;
  walk(doc, (node) => {
    if (firstImageAttachmentId === null && node.type === 'image') {
      const id = node.attrs?.attachmentId;
      if (typeof id === 'string') firstImageAttachmentId = id;
    }
  });
  return { description, firstImageAttachmentId };
}

/** Ids of the users mentioned in the document, in order of first appearance. */
export function extractMentions(doc: ContentNode): string[] {
  const ids = new Set<string>();
  walk(doc, (node) => {
    if (node.type !== 'mention') return;
    const id = node.attrs?.id;
    if (typeof id === 'string') ids.add(id);
  });
  return [...ids];
}

/** Ids of the blocks that carry one (comment anchors), in document order. */
export function extractBlockIds(doc: ContentNode): string[] {
  const ids = new Set<string>();
  walk(doc, (node) => {
    if (node.type === 'doc' || INLINE_TYPES.has(node.type)) return;
    const id = node.attrs?.id;
    if (typeof id === 'string') ids.add(id);
  });
  return [...ids];
}
