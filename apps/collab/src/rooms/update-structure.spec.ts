import { contentJsonToYDoc } from '@collab-docs/shared/content';
import * as Y from 'yjs';
import { structureViolation } from './update-structure';

/** The update that turns an empty document into what `edit` leaves in it. */
function updateOf(edit: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  edit(doc);
  return Y.encodeStateAsUpdate(doc);
}
const check = (update: Uint8Array) => structureViolation(Y.decodeUpdate(update));

function paragraph(text: string, attrs: Record<string, string> = {}): Y.XmlElement {
  const element = new Y.XmlElement('paragraph');
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  element.insert(0, [new Y.XmlText(text)]);
  return element;
}

describe('structureViolation', () => {
  it('accepts every node, attribute and mark of the content model, as the editor writes them', () => {
    const doc = contentJsonToYDoc({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { id: 'h1', level: 2 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p1' },
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            {
              type: 'text',
              text: 'link',
              marks: [{ type: 'link', attrs: { href: 'https://a.b' } }],
            },
            { type: 'hardBreak' },
            {
              type: 'mention',
              attrs: { id: '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', label: 'Ada' },
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
          type: 'orderedList',
          attrs: { start: 3 },
          content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'sql' },
          content: [{ type: 'text', text: 'select 1' }],
        },
        {
          type: 'image',
          attrs: { attachmentId: '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c', alt: 'x' },
        },
      ],
    });
    expect(check(Y.encodeStateAsUpdate(doc))).toBeNull();
  });

  it("accepts Tiptap's position map beside the content", () => {
    const update = updateOf((doc) => {
      doc.getXmlFragment('content').insert(0, [paragraph('a')]);
      doc.getMap('__tiptap_position_migrations:root:content').set('12345:6', { to: 3 });
    });
    expect(check(update)).toBeNull();
  });

  it.each([
    [
      'an element outside the model',
      (doc: Y.Doc) => doc.getXmlFragment('content').insert(0, [new Y.XmlElement('script')]),
    ],
    [
      'an attribute outside the model',
      (doc: Y.Doc) => doc.getXmlFragment('content').insert(0, [paragraph('a', { onclick: 'x()' })]),
    ],
    [
      'a mark outside the model',
      (doc: Y.Doc) => {
        const text = new Y.XmlText();
        doc.getXmlFragment('content').insert(0, [text]);
        text.insert(0, 'a', { blink: true });
      },
    ],
    ['another root', (doc: Y.Doc) => doc.getText('elsewhere').insert(0, 'hidden')],
    [
      'a type the editor never writes',
      (doc: Y.Doc) =>
        doc.getXmlFragment('content').insert(0, [new Y.Map() as unknown as Y.XmlText]),
    ],
    [
      'a subdocument',
      (doc: Y.Doc) => {
        const element = new Y.XmlElement('paragraph');
        doc.getXmlFragment('content').insert(0, [element]);
        element.setAttribute('id', new Y.Doc() as unknown as string);
      },
    ],
  ])('refuses %s', (_name, edit) => {
    expect(check(updateOf(edit as (doc: Y.Doc) => void))).not.toBeNull();
  });

  it('names what it refused', () => {
    expect(
      check(
        updateOf((doc) => doc.getXmlFragment('content').insert(0, [new Y.XmlElement('iframe')])),
      ),
    ).toBe('element "iframe"');
    expect(
      check(
        updateOf((doc) =>
          doc.getXmlFragment('content').insert(0, [paragraph('a', { style: 'x' })]),
        ),
      ),
    ).toBe('attribute "style"');
  });

  it('accepts an overlapping mark the way y-tiptap names it', () => {
    const update = updateOf((doc) => {
      const text = new Y.XmlText();
      doc.getXmlFragment('content').insert(0, [text]);
      text.insert(0, 'a', { 'link--9f86d081': { href: 'https://a.b' } });
    });
    expect(check(update)).toBeNull();
  });
});
