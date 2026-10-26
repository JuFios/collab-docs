import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

const LABEL_LENGTH = 60;

const TYPE_LABELS: Record<string, string> = {
  paragraph: 'Empty paragraph',
  heading: 'Empty heading',
  codeBlock: 'Code block',
  image: 'Image',
};

function labelOf(node: ProseMirrorNode): string {
  const text = node.textContent.replace(/\s+/g, ' ').trim();
  if (!text) return TYPE_LABELS[node.type.name] ?? 'Block';
  const chars = [...text];
  return chars.length <= LABEL_LENGTH ? text : `${chars.slice(0, LABEL_LENGTH - 1).join('')}…`;
}

/** A short text for each of the given blocks that is still in the document (the first words, or its kind). */
export function blockLabels(
  doc: ProseMirrorNode,
  blockIds: ReadonlySet<string>,
): Record<string, string> {
  const labels: Record<string, string> = {};
  if (blockIds.size === 0) return labels;
  doc.descendants((node) => {
    const id: unknown = node.attrs.id;
    if (typeof id === 'string' && blockIds.has(id) && node.isBlock) labels[id] = labelOf(node);
    // a text block has no blocks inside; the walk would only visit its text
    return !node.isTextblock;
  });
  return labels;
}

export function findBlockPosition(doc: ProseMirrorNode, blockId: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isBlock && node.attrs.id === blockId) {
      found = pos;
      return false;
    }
    return !node.isTextblock;
  });
  return found;
}

/** Scrolls the block into view (without animation when the user asked for less motion). Returns whether it exists. */
export function scrollToBlock(editor: Editor, blockId: string): boolean {
  const position = findBlockPosition(editor.state.doc, blockId);
  if (position === null) return false;
  const element = editor.view.nodeDOM(position);
  if (element instanceof HTMLElement) {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    element.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }
  return true;
}
