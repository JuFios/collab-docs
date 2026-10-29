import { contentJsonToYDoc } from '@collab-docs/shared/content';
import * as Y from 'yjs';
import { heldBackViolation, structureViolation } from './update-structure';

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
      'a type in the position map',
      (doc: Y.Doc) =>
        doc.getMap('__tiptap_position_migrations:root:content').set('1:2', new Y.Text()),
    ],
    [
      'a nested map in the position map',
      (doc: Y.Doc) =>
        doc.getMap('__tiptap_position_migrations:root:content').set('1:2', new Y.Map()),
    ],
    [
      'a subdocument in the position map',
      (doc: Y.Doc) =>
        doc.getMap('__tiptap_position_migrations:root:content').set('1:2', new Y.Doc()),
    ],
    [
      'binary data in the position map',
      (doc: Y.Doc) =>
        doc
          .getMap('__tiptap_position_migrations:root:content')
          .set('1:2', new Uint8Array(1024) as unknown as object),
    ],
    [
      'a free-form key in the position map',
      (doc: Y.Doc) => doc.getMap('__tiptap_position_migrations:root:content').set('junk', 1),
    ],
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
        const element = new Y.XmlElement('paragraph');
        doc.getXmlFragment('content').insert(0, [element]);
        element.insert(0, [text]);
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
      const element = new Y.XmlElement('paragraph');
      doc.getXmlFragment('content').insert(0, [element]);
      element.insert(0, [text]);
      text.insert(0, 'a', { 'link--9f86d081': { href: 'https://a.b' } });
    });
    expect(check(update)).toBeNull();
  });

  describe('against the document the update is applied to', () => {
    /** The update `edit` makes to a copy of `base`, and the document it is to be applied to. */
    function against(base: (doc: Y.Doc) => void, edit: (doc: Y.Doc) => void) {
      const room = new Y.Doc();
      base(room);
      const client = new Y.Doc();
      Y.applyUpdate(client, Y.encodeStateAsUpdate(room));
      const before = Y.encodeStateVector(client);
      edit(client);
      const decoded = Y.decodeUpdate(Y.encodeStateAsUpdate(client, before));
      return { room, decoded, violation: structureViolation(decoded, room) };
    }
    const withParagraph = (doc: Y.Doc) => doc.getXmlFragment('content').insert(0, [paragraph('a')]);
    const withMigration = (doc: Y.Doc) =>
      doc.getMap('__tiptap_position_migrations:root:content').set('1:2', 1);

    it('accepts ordinary edits beside what is already there', () => {
      const { violation } = against(withParagraph, (doc) => {
        const fragment = doc.getXmlFragment('content');
        fragment.insert(1, [paragraph('b', { id: 'p2' })]);
        (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
        ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(1, 'more', { bold: true });
        doc.getMap('__tiptap_position_migrations:root:content').set('1:2', { to: 4 });
      });
      expect(violation).toBeNull();
    });

    it('refuses a type that overwrites a key of the position map', () => {
      const { violation } = against(withMigration, (doc) =>
        doc.getMap('__tiptap_position_migrations:root:content').set('1:2', new Y.Text('junk')),
      );
      expect(violation).not.toBeNull();
    });

    it('refuses text and plain values inserted next to an element in the document', () => {
      const { violation } = against(withParagraph, (doc) => {
        // written the way a hostile client would: a raw string item right after the paragraph
        const fragment = doc.getXmlFragment('content');
        const text = new Y.XmlText();
        fragment.insert(1, [text]);
      });
      expect(violation).toBe('text inside "doc"');
    });

    it('refuses an element that cannot sit where it was put', () => {
      const { violation } = against(
        (doc) => {
          const code = new Y.XmlElement('codeBlock');
          code.insert(0, [new Y.XmlText('x')]);
          doc.getXmlFragment('content').insert(0, [code]);
        },
        (doc) => {
          const code = doc.getXmlFragment('content').get(0) as Y.XmlElement;
          code.insert(1, [new Y.XmlElement('image')]);
        },
      );
      expect(violation).toBe('element "image" inside "codeBlock"');
    });

    it('refuses an element inside text, and an attribute the node does not have', () => {
      const inText = against(withParagraph, (doc) => {
        const element = doc.getXmlFragment('content').get(0) as Y.XmlElement;
        (element.get(0) as Y.XmlText).insertEmbed(1, { x: 1 });
      });
      expect(inText.violation).not.toBeNull();
      const attribute = against(withParagraph, (doc) => {
        (doc.getXmlFragment('content').get(0) as Y.XmlElement).setAttribute('level', '2');
      });
      expect(attribute.violation).toBe('attribute "level"');
    });

    it('checks what waits for a change the room does not have once that change arrives', () => {
      const sender = new Y.Doc();
      withParagraph(sender);
      const before = Y.encodeStateVector(sender);
      const element = sender.getXmlFragment('content').get(0) as Y.XmlElement;
      (element.get(0) as Y.XmlText).insert(1, 'tail');
      const late = Y.encodeStateAsUpdate(sender, before);
      const base = Y.encodeStateAsUpdate(sender, Y.encodeStateVector(new Y.Doc()));

      const room = new Y.Doc();
      // the later change arrives first: its neighbour is unknown, so Yjs holds it back
      Y.applyUpdate(room, late);
      expect(room.store.pendingStructs).not.toBeNull();
      expect(structureViolation(Y.decodeUpdate(late), room)).toBeNull();
      expect(heldBackViolation(Y.decodeUpdate(base), room)).toBeNull();
    });

    it('refuses held-back garbage as soon as what it waits for is there', () => {
      const sender = new Y.Doc();
      withMigration(sender);
      const before = Y.encodeStateVector(sender);
      sender.getMap('__tiptap_position_migrations:root:content').set('1:2', new Y.Text('junk'));
      const garbage = Y.encodeStateAsUpdate(sender, before);
      const base = Y.encodeStateAsUpdate(sender, Y.encodeStateVector(new Y.Doc()));

      const room = new Y.Doc();
      Y.applyUpdate(room, garbage);
      expect(room.store.pendingStructs).not.toBeNull();
      expect(heldBackViolation(Y.decodeUpdate(base), room)).not.toBeNull();
    });
  });
});
