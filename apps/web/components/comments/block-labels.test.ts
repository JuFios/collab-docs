import { createContentSchema } from '@collab-docs/shared/content';
import { describe, expect, it } from 'vitest';
import { blockLabels, findBlockPosition } from './block-labels';

const schema = createContentSchema();
const ATTACHMENT = '11111111-1111-4111-8111-111111111111';
const doc = schema.nodeFromJSON({
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { id: 'h', level: 1 },
      content: [{ type: 'text', text: 'Quarterly plan' }],
    },
    { type: 'paragraph', attrs: { id: 'empty' } },
    {
      type: 'paragraph',
      attrs: { id: 'long' },
      content: [{ type: 'text', text: `${'word '.repeat(30)}end` }],
    },
    {
      type: 'bulletList',
      attrs: { id: 'ul' },
      content: [
        {
          type: 'listItem',
          attrs: { id: 'li' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'inner' },
              content: [{ type: 'text', text: 'In a list' }],
            },
          ],
        },
      ],
    },
    { type: 'image', attrs: { id: 'img', attachmentId: ATTACHMENT } },
    { type: 'codeBlock', attrs: { id: 'code' }, content: [{ type: 'text', text: 'const a = 1;' }] },
  ],
});

describe('blockLabels', () => {
  it('names blocks by their first words, or by their kind when they have none', () => {
    const labels = blockLabels(doc, new Set(['h', 'empty', 'inner', 'img', 'code']));
    expect(labels).toEqual({
      h: 'Quarterly plan',
      empty: 'Empty paragraph',
      inner: 'In a list',
      img: 'Image',
      code: 'const a = 1;',
    });
  });

  it('cuts long text', () => {
    const label = blockLabels(doc, new Set(['long']))['long']!;
    expect([...label]).toHaveLength(60);
    expect(label.endsWith('…')).toBe(true);
  });

  it('leaves out blocks that are gone, and does no work when nothing is asked', () => {
    expect(blockLabels(doc, new Set(['deleted']))).toEqual({});
    expect(blockLabels(doc, new Set())).toEqual({});
  });
});

describe('findBlockPosition', () => {
  it('finds a block, also inside lists', () => {
    expect(findBlockPosition(doc, 'h')).toBe(0);
    const inner = findBlockPosition(doc, 'inner');
    expect(inner).not.toBeNull();
    expect(doc.nodeAt(inner!)?.attrs.id).toBe('inner');
  });

  it('answers null for a block that does not exist', () => {
    expect(findBlockPosition(doc, 'deleted')).toBeNull();
  });
});
