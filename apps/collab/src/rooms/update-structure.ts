import * as Y from 'yjs';
import { CONTENT_FIELD, MARK_NAMES, NODE_NAMES, NODE_SPECS } from '@collab-docs/shared/content';

/** Element names of the content model (`doc` is the fragment itself and `text` is `Y.XmlText`). */
const ELEMENTS: ReadonlySet<string> = new Set(
  NODE_NAMES.filter((name) => name !== 'doc' && name !== 'text'),
);
const MARKS: ReadonlySet<string> = new Set(MARK_NAMES);
/**
 * Tiptap's Collaboration extension keeps a map beside the content for mapping positions across versions; its keys are
 * Yjs ids (`client:clock`) and its values plain data.
 */
const POSITION_MIGRATIONS = `__tiptap_position_migrations:root:${CONTENT_FIELD}`;
const POSITION_MIGRATION_KEY = /^\d+:\d+$/;

type Struct = Y.Item | Y.GC | Y.Skip;
type ItemContent = Y.Item['content'];
type Id = { client: number; clock: number };

/** What an item sits in: a root type (by name) or a type nested in the document, and under which key. */
type Place = {
  container: { root: string } | { type: Y.AbstractType<unknown> };
  parentSub: string | null;
};
/** `dropped`: Yjs discards the item (it builds on content that was already garbage collected). */
type Located = Place | 'dropped' | 'missing';

const nodeSpec = (name: string) =>
  (
    NODE_SPECS as Record<
      string,
      { children: readonly string[]; attrs: Record<string, unknown> } | undefined
    >
  )[name];

/**
 * Finds where each item of an update ends up. Yjs omits the parent and the key of an item that has an origin (it
 * inherits them from the neighbour it was inserted next to), so for those the neighbour is looked up: among the
 * structs of the same update, or in the document the update is applied to.
 */
class Locator {
  private readonly byClient = new Map<number, Struct[]>();
  private readonly cache = new Map<Y.Item, Located>();

  constructor(
    structs: Struct[],
    private readonly doc: Y.Doc | undefined,
  ) {
    for (const struct of structs) {
      const list = this.byClient.get(struct.id.client) ?? [];
      list.push(struct);
      this.byClient.set(struct.id.client, list);
    }
    for (const list of this.byClient.values()) list.sort((a, b) => a.id.clock - b.id.clock);
  }

  private find(id: Id): Struct | undefined {
    const list = this.byClient.get(id.client);
    if (list) {
      let low = 0;
      let high = list.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const struct = list[middle] as Struct;
        if (id.clock < struct.id.clock) high = middle - 1;
        else if (id.clock >= struct.id.clock + struct.length) low = middle + 1;
        else return struct;
      }
    }
    if (this.doc && Y.getState(this.doc.store, id.client) > id.clock) {
      return Y.getItem(this.doc.store, id as Y.ID) as Struct;
    }
    return undefined;
  }

  private rootName(type: Y.AbstractType<unknown>): string | undefined {
    for (const [name, root] of this.doc?.share ?? []) if (root === type) return name;
    return undefined;
  }

  locate(start: Y.Item): Located {
    const chain: Y.Item[] = [];
    let current: Struct | undefined = start;
    let result: Located | undefined;
    while (result === undefined) {
      if (current === undefined || current instanceof Y.Skip) {
        result = 'missing';
      } else if (current instanceof Y.GC) {
        result = 'dropped';
      } else if (this.cache.has(current)) {
        result = this.cache.get(current);
      } else {
        chain.push(current);
        const parent: unknown = current.parent;
        if (typeof parent === 'string') {
          result = { container: { root: parent }, parentSub: current.parentSub };
        } else if (parent instanceof Y.AbstractType) {
          // an item the room already holds
          const root = parent._item === null ? this.rootName(parent) : undefined;
          result = root
            ? { container: { root }, parentSub: current.parentSub }
            : { container: { type: parent }, parentSub: current.parentSub };
        } else if (parent !== null && typeof parent === 'object') {
          const holder = this.find(parent as Id);
          if (holder === undefined) result = 'missing';
          else if (holder instanceof Y.GC) result = 'dropped';
          else if (holder instanceof Y.Item && holder.content instanceof Y.ContentType) {
            result = { container: { type: holder.content.type }, parentSub: current.parentSub };
          } else result = 'missing';
        } else {
          const neighbour: Id | null = current.origin ?? current.rightOrigin;
          current = neighbour ? this.find(neighbour) : undefined;
        }
      }
    }
    for (const item of chain) this.cache.set(item, result);
    return result;
  }
}

/** Why `content` may not be stored in `place`, or `null` when it may. */
function misplaced(place: Place, content: ItemContent): string | null {
  const { container, parentSub } = place;
  const kind = content.constructor.name;
  if (content instanceof Y.ContentDeleted) return null;

  if ('root' in container) {
    if (container.root === POSITION_MIGRATIONS) {
      // plain data under an id-shaped key, nothing else: no types, subdocuments, binaries or free-form keys
      const plain = content instanceof Y.ContentAny || content instanceof Y.ContentJSON;
      return plain && parentSub !== null && POSITION_MIGRATION_KEY.test(parentSub)
        ? null
        : `position map entry ${kind}`;
    }
    if (container.root !== CONTENT_FIELD) return `root "${container.root}"`;
    return inElement('doc', content, parentSub);
  }

  const { type } = container;
  if (type instanceof Y.XmlElement) return inElement(type.nodeName, content, parentSub);
  if (type instanceof Y.XmlText) {
    if (parentSub !== null) return `attribute "${parentSub}" on text`;
    if (content instanceof Y.ContentString) return null;
    if (content instanceof Y.ContentFormat) {
      // y-tiptap names an overlapping mark `name--hash`
      const mark = content.key.split('--')[0] ?? '';
      return MARKS.has(mark) ? null : `mark "${content.key}"`;
    }
    return `content ${kind} in text`;
  }
  return `type ${type.constructor.name}`;
}

/** What an element of the content model (or the document itself, named `doc`) may hold. */
function inElement(name: string, content: ItemContent, parentSub: string | null): string | null {
  const spec = nodeSpec(name);
  if (!spec) return `element "${name}"`;
  if (parentSub !== null) {
    // y-tiptap stores the marks of a node that is not text (a mention, a line break) as attributes named after
    // the mark, `name--hash` when they overlap; the editor allows them there, the model strips them on the way out
    const mark = parentSub.split('--')[0] ?? '';
    if (!(parentSub in spec.attrs) && !MARKS.has(mark)) return `attribute "${parentSub}"`;
    return content instanceof Y.ContentAny
      ? null
      : `content ${content.constructor.name} as attribute`;
  }
  if (!(content instanceof Y.ContentType)) {
    return `content ${content.constructor.name} directly in "${name}"`;
  }
  const { type } = content;
  if (type instanceof Y.XmlElement) {
    if (!ELEMENTS.has(type.nodeName)) return `element "${type.nodeName}"`;
    return spec.children.includes(type.nodeName)
      ? null
      : `element "${type.nodeName}" inside "${name}"`;
  }
  if (type instanceof Y.XmlText) {
    return spec.children.includes('text') ? null : `text inside "${name}"`;
  }
  return `type ${type.constructor.name}`;
}

/** The structs Yjs holds back because they wait for changes the room has not received (none when nothing waits). */
function heldBack(doc: Y.Doc | undefined): Struct[] {
  const pending = doc?.store.pendingStructs;
  return pending ? (Y.decodeUpdateV2(pending.update).structs as Struct[]) : [];
}

function firstViolation(structs: Struct[], locator: Locator): string | null {
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    const place = locator.locate(struct);
    // a reference the room cannot resolve yet: the item waits (see `heldBackViolation`), it is not stored
    if (place === 'dropped' || place === 'missing') continue;
    const violation = misplaced(place, struct.content);
    if (violation) return violation;
  }
  return null;
}

/**
 * Why an update does not fit the content model, or `null` when it does. Checked on the decoded update before it
 * reaches the room, so a hostile client cannot store elements, attributes, marks, types or nesting that the editor
 * would never write: they would be stripped on the way out anyway (`sanitizeContent`), but would stay in the database.
 *
 * Every new item is checked against the container it lands in, found from the update itself, from the changes held
 * back and from `doc`, the document the update is applied to (without it, only references within the update
 * resolve). An item that waits for a change the room does not have is not stored yet; `heldBackViolation` checks it
 * once that change arrives.
 */
export function structureViolation(decoded: { structs: Struct[] }, doc?: Y.Doc): string | null {
  const held = heldBack(doc);
  return firstViolation(decoded.structs, new Locator([...decoded.structs, ...held], doc));
}

/**
 * Like `structureViolation` for the changes the room holds back: what they waited for may be in `decoded`, and
 * Yjs integrates them with it, so they are checked together. Call it with the update before it is applied; a
 * violation means the held-back changes are to be dropped.
 */
export function heldBackViolation(decoded: { structs: Struct[] }, doc: Y.Doc): string | null {
  const held = heldBack(doc);
  return firstViolation(held, new Locator([...decoded.structs, ...held], doc));
}
