import * as Y from 'yjs';
import { CONTENT_FIELD, MARK_NAMES, NODE_NAMES, NODE_SPECS } from '@collab-docs/shared/content';

/** Element names of the content model (`doc` is the fragment itself and `text` is `Y.XmlText`). */
const ELEMENTS: ReadonlySet<string> = new Set(
  NODE_NAMES.filter((name) => name !== 'doc' && name !== 'text'),
);
const ATTRIBUTES: ReadonlySet<string> = new Set(
  Object.values(NODE_SPECS).flatMap((spec) => Object.keys(spec.attrs)),
);
const MARKS: ReadonlySet<string> = new Set(MARK_NAMES);
/**
 * Tiptap's Collaboration extension keeps a map beside the content for mapping positions across versions; its keys are
 * Yjs ids (`client:clock`) and its values plain data.
 */
const POSITION_MIGRATIONS = `__tiptap_position_migrations:root:${CONTENT_FIELD}`;

/**
 * Why an update does not fit the content model, or `null` when it does. Checked on the decoded update before it
 * reaches the room, so a hostile client cannot store elements, attributes, marks or types that the editor would
 * never write: they would be stripped on the way out anyway (`sanitizeContent`), but would stay in the database.
 *
 * Yjs omits the parent and the key of an item that has an origin (they follow from it), so what this sees is every
 * new element, mark and type, and every attribute or root the first time it is written, which is enough: a later
 * write can only reuse a key or a parent that was checked when it appeared.
 */
export function structureViolation(decoded: {
  structs: Array<Y.Item | Y.GC | Y.Skip>;
}): string | null {
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) continue;
    if (typeof struct.parent === 'string') {
      if (struct.parent === POSITION_MIGRATIONS) continue;
      if (struct.parent !== CONTENT_FIELD) return `root "${struct.parent}"`;
    }
    const { content } = struct;
    if (content instanceof Y.ContentType) {
      const { type } = content;
      if (type instanceof Y.XmlElement) {
        if (!ELEMENTS.has(type.nodeName)) return `element "${type.nodeName}"`;
      } else if (!(type instanceof Y.XmlText)) {
        return `type ${type.constructor.name}`;
      }
    } else if (content instanceof Y.ContentFormat) {
      // y-tiptap names an overlapping mark `name--hash`
      const mark = content.key.split('--')[0] ?? '';
      if (!MARKS.has(mark)) return `mark "${content.key}"`;
    } else if (
      content instanceof Y.ContentEmbed ||
      content instanceof Y.ContentBinary ||
      content instanceof Y.ContentDoc
    ) {
      return `content ${content.constructor.name}`;
    }
    if (struct.parentSub !== null && !ATTRIBUTES.has(struct.parentSub)) {
      return `attribute "${struct.parentSub}"`;
    }
  }
  return null;
}
