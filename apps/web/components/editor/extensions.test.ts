// @vitest-environment jsdom
import {
  MARK_NAMES,
  NODE_NAMES,
  NODE_SPECS,
  createContentSchema,
} from '@collab-docs/shared/content';
import { Editor } from '@tiptap/core';
import { Awareness } from 'y-protocols/awareness';
import type { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions } from './extensions';

let editor: Editor | undefined;

function build(): Editor {
  const ydoc = new Y.Doc();
  const provider = {
    awareness: new Awareness(ydoc),
    on: () => undefined,
    off: () => undefined,
  } as unknown as WebsocketProvider;
  editor = new Editor({
    extensions: createEditorExtensions({
      ydoc,
      provider,
      pickImage: () => undefined,
      editable: true,
    }),
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

describe('editor schema', () => {
  it('has exactly the nodes and marks of the content model', () => {
    const { schema } = build();
    expect(Object.keys(schema.nodes).sort()).toEqual([...NODE_NAMES].sort());
    expect(Object.keys(schema.marks).sort()).toEqual([...MARK_NAMES].sort());
  });

  it('agrees with the content model on structure', () => {
    const { schema } = build();
    const model = createContentSchema();
    for (const name of NODE_NAMES) {
      const actual = schema.nodes[name];
      const expected = model.nodes[name];
      expect(actual, name).toBeDefined();
      expect(actual?.isInline, `${name} inline`).toBe(expected?.isInline);
      expect(actual?.isAtom, `${name} atom`).toBe(expected?.isAtom);
      expect(actual?.isBlock, `${name} block`).toBe(expected?.isBlock);
    }
  });

  it('keeps node attributes within the allowlist (the sanitiser drops the rest)', () => {
    const { schema } = build();
    for (const [name, spec] of Object.entries(NODE_SPECS)) {
      const extra = Object.keys(schema.nodes[name]?.spec.attrs ?? {}).filter(
        (attribute) => !(attribute in spec.attrs),
      );
      expect(extra, `${name} has attributes outside the model`).toEqual([]);
    }
  });

  it('writes a block id on new blocks', () => {
    const instance = build();
    instance.commands.insertContent({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Hi' }],
    });
    const ids: unknown[] = [];
    instance.state.doc.descendants((node) => {
      if (node.type.name === 'heading' || node.type.name === 'paragraph') ids.push(node.attrs.id);
    });
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
