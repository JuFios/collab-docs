// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockComments, BlockCommentsController, blockAtSelection } from './block-comments';

/** The block id attribute that UniqueID adds in the real editor. */
const BlockIds = Extension.create({
  name: 'blockIds',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'listItem', 'bulletList'],
        attributes: {
          id: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-id'),
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.id ? { 'data-id': attributes.id } : {},
          },
        },
      },
    ];
  },
});

const doc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: 'h1', level: 1 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'text', text: 'First' }] },
    {
      type: 'bulletList',
      attrs: { id: 'ul' },
      content: [
        {
          type: 'listItem',
          attrs: { id: 'li' },
          content: [
            { type: 'paragraph', attrs: { id: 'p2' }, content: [{ type: 'text', text: 'Item' }] },
          ],
        },
      ],
    },
  ],
};

let editor: Editor;
let controller: BlockCommentsController;

beforeEach(() => {
  controller = new BlockCommentsController();
  controller.onAdd = vi.fn();
  controller.onOpen = vi.fn();
  editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: [StarterKit, BlockIds, BlockComments.configure({ controller })],
    content: doc,
  });
});

afterEach(() => {
  editor.destroy();
  document.body.innerHTML = '';
});

const markers = () => [...editor.view.dom.querySelectorAll<HTMLElement>('.block-comment-anchor')];

describe('BlockComments', () => {
  it('shows nothing to someone who cannot comment, until a block has threads', () => {
    expect(markers()).toHaveLength(0);
    controller.update({ counts: new Map([['p1', 2]]) });
    expect(markers()).toHaveLength(1);
    expect(markers()[0]).toHaveAttribute('data-count', '2');
    expect(markers()[0]!.querySelector('button')).toHaveAttribute(
      'aria-label',
      '2 open comment threads, show',
    );
  });

  it('puts an add button on every text block of someone who can comment, not on the lists around them', () => {
    controller.update({ canComment: true });
    const parents = markers().map((marker) => marker.parentElement?.getAttribute('data-id'));
    expect(parents).toEqual(['h1', 'p1', 'p2']);
    expect(markers().every((marker) => marker.dataset.count === '0')).toBe(true);
    // a tab stop per block would make the page unusable by keyboard
    expect(markers()[0]!.querySelector('button')).toHaveAttribute('tabindex', '-1');
  });

  it('starts a thread from the add button and opens threads from the count', () => {
    controller.update({ canComment: true, counts: new Map([['p1', 1]]) });
    const [add, open] = markers().map((marker) => marker.querySelector('button')!);
    add!.click();
    expect(controller.onAdd).toHaveBeenCalledWith('h1');
    open!.click();
    expect(controller.onOpen).toHaveBeenCalledWith('p1');
  });

  it('follows the document: a new block gets its marker', () => {
    controller.update({ canComment: true });
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: 'paragraph',
      attrs: { id: 'p3' },
      content: [{ type: 'text', text: 'New' }],
    });
    expect(markers().map((marker) => marker.parentElement?.getAttribute('data-id'))).toContain(
      'p3',
    );
  });

  it('highlights the block a thread points at, and stops again', () => {
    controller.update({ highlighted: 'p1' });
    expect(editor.view.dom.querySelector('[data-id="p1"]')).toHaveClass('comment-highlight');
    controller.update({ highlighted: null });
    expect(editor.view.dom.querySelector('.comment-highlight')).toBeNull();
  });

  it('does not take focus from the text when a marker is pressed', () => {
    controller.update({ canComment: true });
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    markers()[0]!.querySelector('button')!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it('starts a comment on the block with the caret from the keyboard', () => {
    controller.update({ canComment: true });
    editor.commands.setTextSelection(editor.state.doc.resolve(1).pos + 9);
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'm',
        code: 'KeyM',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
      }),
    );
    expect(controller.onAdd).toHaveBeenCalledTimes(1);
  });

  it('leaves the shortcut alone for someone who cannot comment', () => {
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'm',
        code: 'KeyM',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
      }),
    );
    expect(controller.onAdd).not.toHaveBeenCalled();
  });
});

describe('blockAtSelection', () => {
  it('finds the text block the caret is in', () => {
    editor.commands.setTextSelection(3);
    expect(blockAtSelection(editor.state.selection)).toBe('h1');
  });
});
