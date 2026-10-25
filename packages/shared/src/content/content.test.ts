import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  contentJsonToYDoc,
  createContentSchema,
  extractBlockIds,
  extractMentions,
  extractMeta,
  extractPlainText,
  sanitizeContent,
  yDocToContentJson,
} from './index';

const USER_A = '0190b2c4-7d6a-7000-8000-0123456789ab';
const USER_B = '0190b2c4-7d6a-7000-8000-0123456789ac';
const IMAGE = '0190b2c4-7d6a-7000-8000-0123456789ad';

const sample = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: 'h1', level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
    {
      type: 'paragraph',
      attrs: { id: 'p1' },
      content: [
        { type: 'text', text: 'Hi ' },
        { type: 'mention', attrs: { id: USER_A, label: 'Ann' } },
        { type: 'hardBreak' },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'mention', attrs: { id: USER_A, label: 'Ann' } },
        { type: 'mention', attrs: { id: USER_B, label: 'Bob' } },
      ],
    },
    { type: 'image', attrs: { id: 'img1', attachmentId: IMAGE, alt: 'chart' } },
    {
      type: 'orderedList',
      attrs: { start: 3 },
      content: [
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
        },
      ],
    },
    {
      type: 'codeBlock',
      attrs: { language: 'json' },
      content: [{ type: 'text', text: '{\n  "a": 1\n}' }],
    },
  ],
};

describe('yDocToContentJson', () => {
  it('returns an empty document for an untouched Y.Doc', () => {
    expect(yDocToContentJson(new Y.Doc())).toEqual({ type: 'doc', content: [] });
    expect(sanitizeContent(yDocToContentJson(new Y.Doc())).content).toEqual([
      { type: 'paragraph' },
    ]);
  });

  it('round-trips ProseMirror JSON through a Y.Doc', () => {
    const roundTripped = yDocToContentJson(contentJsonToYDoc(sample));
    expect(sanitizeContent(roundTripped)).toEqual(sanitizeContent(sample));
  });

  it('round-trips through an encoded update (what the server stores)', () => {
    const source = contentJsonToYDoc(sample);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(source));
    expect(sanitizeContent(yDocToContentJson(restored))).toEqual(sanitizeContent(sample));
  });

  it('produces JSON the schema accepts', () => {
    const schema = createContentSchema();
    const json = sanitizeContent(yDocToContentJson(contentJsonToYDoc(sample)));
    expect(() => schema.nodeFromJSON(json).check()).not.toThrow();
  });

  it('reads concurrent edits made on two replicas', () => {
    const a = contentJsonToYDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'base' }] }],
    });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const textOf = (doc: Y.Doc) => doc.getXmlFragment('content').get(0) as Y.XmlElement;
    (textOf(a).get(0) as Y.XmlText).insert(0, 'A-');
    (textOf(b).get(0) as Y.XmlText).insert(4, '-B');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(extractPlainText(yDocToContentJson(a))).toBe('A-base-B');
    expect(yDocToContentJson(a)).toEqual(yDocToContentJson(b));
  });
});

describe('extraction', () => {
  const clean = sanitizeContent(sample);

  it('extractPlainText puts blocks and list items on separate lines', () => {
    expect(extractPlainText(clean)).toBe(
      ['Plan', 'Hi @Ann', 'bold and @Ann@Bob', 'first', 'nested', 'done', '{\n  "a": 1\n}'].join(
        '\n',
      ),
    );
  });

  it('extractMeta collapses whitespace and limits the description to 160 characters', () => {
    const meta = extractMeta(clean);
    expect(meta.description).toBe('Plan Hi @Ann bold and @Ann@Bob first nested done { "a": 1 }');
    expect(meta.firstImageAttachmentId).toBe(IMAGE);

    const long = sanitizeContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'word '.repeat(100) }] }],
    });
    const description = extractMeta(long).description;
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description.endsWith('…')).toBe(true);
    expect(extractMeta(sanitizeContent(null))).toEqual({
      description: '',
      firstImageAttachmentId: null,
    });
  });

  it('extractMentions lists each user once, in order', () => {
    expect(extractMentions(clean)).toEqual([USER_A, USER_B]);
  });

  it('extractBlockIds lists block ids but not inline ones', () => {
    expect(extractBlockIds(clean)).toEqual(['h1', 'p1', 'img1']);
  });

  it('tolerates unsanitised input', () => {
    const hostile = {
      type: 'doc',
      content: [
        null,
        1,
        { type: 'paragraph', content: 'x' },
        { type: 'mention', attrs: { id: 5 } },
      ],
    } as never;
    expect(extractPlainText(hostile)).toBe('');
    expect(extractMentions(hostile)).toEqual([]);
  });
});
