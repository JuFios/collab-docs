import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface BlockCommentsState {
  /** Open threads per block id. */
  counts: ReadonlyMap<string, number>;
  /** Whether the viewer may start a thread; without it only blocks that already have threads show a marker. */
  canComment: boolean;
  /** The block a thread was just selected for; flashes until the panel clears it. */
  highlighted: string | null;
}

/**
 * The link between the comments UI and the editor. The editor's extension list must stay the same for as long as
 * the document is open (a new list rebuilds the editor), so changing data (thread counts, the viewer's right to
 * comment) cannot travel as options. It lives here instead: the page updates this object and the plugin redraws.
 */
export class BlockCommentsController {
  state: BlockCommentsState = { counts: new Map(), canComment: false, highlighted: null };
  /** The "add comment" button of a block, or the keyboard shortcut, was used. */
  onAdd: (blockId: string) => void = () => undefined;
  /** The marker of a block that already has threads was used. */
  onOpen: (blockId: string) => void = () => undefined;

  private readonly listeners = new Set<() => void>();

  update(patch: Partial<BlockCommentsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Blocks a comment can be anchored to: text blocks and images, not the lists that wrap them. */
export function commentableId(node: ProseMirrorNode): string | null {
  const id: unknown = node.attrs.id;
  return node.isBlock && (node.isTextblock || node.isLeaf) && typeof id === 'string' && id
    ? id
    : null;
}

/** The block the selection is in, for the keyboard shortcut. */
export function blockAtSelection(selection: Selection): string | null {
  const selected =
    'node' in selection ? (selection.node as ProseMirrorNode | undefined) : undefined;
  if (selected) return commentableId(selected);
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const id = commentableId(selection.$from.node(depth));
    if (id) return id;
  }
  return null;
}

const SVG = 'http://www.w3.org/2000/svg';
const BUBBLE = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z';
const PLUS = 'M12 7v6M9 10h6';

function icon(...paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const SHORTCUT_HINT = 'Ctrl/⌘+Alt+M';

/** The marker in the gutter next to a block: a count when it has open threads, otherwise an "add" button. */
function marker(
  controller: BlockCommentsController,
  blockId: string,
  count: number,
  leaf: boolean,
): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = leaf
    ? 'block-comment-anchor block-comment-anchor-leaf'
    : 'block-comment-anchor';
  wrapper.contentEditable = 'false';
  wrapper.dataset.count = String(count);
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.testid = count > 0 ? 'block-comment-count' : 'block-comment-add';
  if (count > 0) {
    button.setAttribute(
      'aria-label',
      `${count} open comment ${count === 1 ? 'thread' : 'threads'}, show`,
    );
    button.append(
      icon(BUBBLE),
      Object.assign(document.createElement('span'), { textContent: String(count) }),
    );
    button.addEventListener('click', () => controller.onOpen(blockId));
  } else {
    button.setAttribute('aria-label', 'Add a comment to this block');
    button.title = `Add comment (${SHORTCUT_HINT})`;
    // the gutter has a button per block: only the ones that carry threads are worth a tab stop
    button.tabIndex = -1;
    button.append(icon(BUBBLE, PLUS));
    button.addEventListener('click', () => controller.onAdd(blockId));
  }
  // keep the editor's selection and focus where they were
  button.addEventListener('mousedown', (event) => event.preventDefault());
  wrapper.append(button);
  return wrapper;
}

export const blockCommentsKey = new PluginKey<DecorationSet>('blockComments');

function decorate(doc: ProseMirrorNode, controller: BlockCommentsController): DecorationSet {
  const { counts, canComment, highlighted } = controller.state;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const id = commentableId(node);
    if (!id) return !node.isTextblock && !node.isLeaf;
    const count = counts.get(id) ?? 0;
    if (count > 0 || canComment) {
      // inside a text block the marker is positioned against the block; an image has no inside, so it goes before it
      decorations.push(
        Decoration.widget(
          node.isTextblock ? pos + 1 : pos,
          () => marker(controller, id, count, node.isLeaf),
          {
            side: -1,
            key: `${id}:${count}`,
            // clicks belong to the button, not to the editor
            stopEvent: () => true,
            ignoreSelection: true,
          },
        ),
      );
    }
    if (id === highlighted) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'comment-highlight' }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** Markers next to commentable blocks, the highlight of a block a thread points at, and the comment shortcut. */
export const BlockComments = Extension.create<{ controller: BlockCommentsController }>({
  name: 'blockComments',

  addProseMirrorPlugins() {
    const { controller } = this.options;
    return [
      new Plugin<DecorationSet>({
        key: blockCommentsKey,
        state: {
          init: (_config, state) => decorate(state.doc, controller),
          // the walk is cheap (it stops at text blocks) but not free: redo it only when the document or the data changed
          apply: (tr, previous, _old, state) =>
            tr.docChanged || tr.getMeta(blockCommentsKey)
              ? decorate(state.doc, controller)
              : previous,
        },
        props: { decorations: (state) => blockCommentsKey.getState(state) },
        view: (view) => {
          const unsubscribe = controller.subscribe(() =>
            view.dispatch(view.state.tr.setMeta(blockCommentsKey, true)),
          );
          return { destroy: unsubscribe };
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const { controller } = this.options;
    return {
      'Mod-Alt-m': ({ editor }) => {
        const id = blockAtSelection(editor.state.selection);
        if (!id || !controller.state.canComment) return false;
        controller.onAdd(id);
        return true;
      },
    };
  },
});
