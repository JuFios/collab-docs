import {
  type AttrSpec,
  BLOCK_ID_PATTERN,
  CONTENT_LIMITS,
  LINK_PROTOCOLS,
  LINK_REL,
  type MarkName,
  MARK_NAMES,
  NODE_SPECS,
  type NodeName,
  UUID_PATTERN,
} from './schema';
import type { ContentDoc, ContentMark, ContentNode } from './types';

type ContainerName = keyof typeof NODE_SPECS;

// C0 controls except tab/newline/carriage return, DEL and C1 controls, and the bidirectional overrides
// and isolates used for "trojan source" style spoofing.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩￾￿]/g;
// Single-line values (alt, labels, links) lose every control character, including newlines.
// eslint-disable-next-line no-control-regex
const UNSAFE_INLINE_CHARS = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩￾￿]/g;

/** Removes control and bidi-override characters; newlines and tabs survive (code blocks need them). */
export function stripUnsafeChars(value: string): string {
  return value.replace(UNSAFE_CHARS, '');
}

function cleanLine(value: string, maxLength: number): string {
  return value.replace(UNSAFE_INLINE_CHARS, '').slice(0, maxLength);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isContainer = (type: string): type is ContainerName =>
  Object.prototype.hasOwnProperty.call(NODE_SPECS, type) && type !== 'doc';

/** Returns the normalised URL for `http:`, `https:` and `mailto:` links, `null` for everything else. */
export function sanitizeHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(UNSAFE_INLINE_CHARS, '').trim();
  if (!cleaned || cleaned.length > CONTENT_LIMITS.maxHrefLength) return null;
  let url: URL;
  try {
    // no base URL: relative references ("//evil.example", "/x") are rejected rather than resolved
    url = new URL(cleaned);
  } catch {
    return null;
  }
  if (!(LINK_PROTOCOLS as readonly string[]).includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  return url.href;
}

interface Budget {
  nodes: number;
  textLength: number;
}

function sanitizeAttr(spec: AttrSpec, value: unknown): unknown {
  switch (spec.kind) {
    case 'blockId':
      return typeof value === 'string' && BLOCK_ID_PATTERN.test(value) ? value : null;
    case 'uuid':
      return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
    case 'text':
      return typeof value === 'string' ? cleanLine(value, spec.maxLength) : '';
    case 'int':
      return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= spec.min &&
        value <= spec.max
        ? value
        : spec.default;
    case 'bool':
      return typeof value === 'boolean' ? value : spec.default;
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value.toLowerCase())
        ? value.toLowerCase()
        : null;
  }
}

/** Allowlisted attributes only; `null` when a required attribute is missing or invalid (the node is dropped). */
function sanitizeAttrs(
  name: ContainerName,
  raw: unknown,
): Record<string, unknown> | undefined | null {
  const source = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(NODE_SPECS[name].attrs)) {
    const value = sanitizeAttr(spec, source[key]);
    if (value === null && spec.kind === 'uuid' && spec.required) return null;
    if (value !== null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeMarks(raw: unknown): ContentMark[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<MarkName>();
  const marks: ContentMark[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate.type !== 'string') continue;
    const type = candidate.type as MarkName;
    if (!MARK_NAMES.includes(type) || seen.has(type)) continue;
    if (type === 'link') {
      const href = sanitizeHref(isRecord(candidate.attrs) ? candidate.attrs.href : undefined);
      if (!href) continue;
      marks.push({ type, attrs: { href, rel: LINK_REL } });
    } else {
      marks.push({ type });
    }
    seen.add(type);
  }
  return marks.length > 0 ? marks : undefined;
}

const sameMarks = (a?: ContentMark[], b?: ContentMark[]): boolean =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Merges neighbouring text nodes with identical marks (the editor never produces them, a CRDT merge might). */
function mergeText(nodes: ContentNode[]): ContentNode[] {
  const merged: ContentNode[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (
      previous?.type === 'text' &&
      node.type === 'text' &&
      sameMarks(previous.marks, node.marks)
    ) {
      previous.text = `${previous.text ?? ''}${node.text ?? ''}`;
    } else {
      merged.push(node);
    }
  }
  return merged;
}

class Sanitizer {
  private readonly budget: Budget = { nodes: 0, textLength: 0 };

  document(input: unknown): ContentDoc {
    const rawChildren = isRecord(input) ? input.content : undefined;
    let content = this.children(rawChildren, 'doc', 0, 0);
    if (content.length === 0) content = [{ type: 'paragraph' }];
    return { type: 'doc', content };
  }

  /**
   * `depth` counts kept ancestors, `rawDepth` every level of the input walked so far, including
   * wrappers that are unwrapped, so hostile nesting cannot overflow the stack.
   */
  private children(raw: unknown, parent: ContainerName | 'doc', depth: number, rawDepth: number) {
    const out: ContentNode[] = [];
    if (!Array.isArray(raw) || rawDepth > CONTENT_LIMITS.maxRawDepth) return out;
    const spec = NODE_SPECS[parent];

    for (const item of raw) {
      if (this.budget.nodes >= CONTENT_LIMITS.maxNodes) break;
      if (!isRecord(item) || typeof item.type !== 'string') continue;
      const type = item.type;

      if (type === 'text') {
        const node = this.text(item, parent);
        if (!node) continue;
        if (spec.children.includes('text')) out.push(node);
        else if (spec.children.includes('paragraph'))
          out.push(...this.wrapInParagraph(node, depth));
        continue;
      }

      if (!isContainer(type)) {
        // unknown node: its text survives, the node itself does not
        out.push(...this.children(item.content, parent, depth, rawDepth + 1));
        continue;
      }
      if (!spec.children.includes(type as NodeName)) {
        out.push(...this.children(item.content, parent, depth, rawDepth + 1));
        continue;
      }
      if (depth + 1 > CONTENT_LIMITS.maxDepth) continue;

      const node = this.node(type, item, depth, rawDepth);
      if (node) out.push(node);
    }
    return spec.children.includes('text') ? mergeText(out) : out;
  }

  private wrapInParagraph(text: ContentNode, depth: number): ContentNode[] {
    if (depth + 1 > CONTENT_LIMITS.maxDepth || this.budget.nodes >= CONTENT_LIMITS.maxNodes) {
      return [];
    }
    this.budget.nodes += 1;
    return [{ type: 'paragraph', content: [text] }];
  }

  private text(item: Record<string, unknown>, parent: ContainerName | 'doc'): ContentNode | null {
    if (typeof item.text !== 'string') return null;
    const remaining = CONTENT_LIMITS.maxTextLength - this.budget.textLength;
    if (remaining <= 0) return null;
    const text = stripUnsafeChars(item.text).slice(0, remaining);
    if (!text) return null;
    this.budget.textLength += text.length;
    this.budget.nodes += 1;
    const marks = NODE_SPECS[parent].marks === 'all' ? sanitizeMarks(item.marks) : undefined;
    return marks ? { type: 'text', text, marks } : { type: 'text', text };
  }

  private node(
    type: ContainerName,
    item: Record<string, unknown>,
    depth: number,
    rawDepth: number,
  ): ContentNode | null {
    const attrs = sanitizeAttrs(type, item.attrs);
    if (attrs === null) return null;
    this.budget.nodes += 1;

    const node: ContentNode = { type };
    if (attrs) node.attrs = attrs;
    const spec = NODE_SPECS[type];
    if (spec.children.length === 0) return node;

    let content = this.children(item.content, type, depth + 1, rawDepth + 1);
    if (type === 'bulletList' || type === 'orderedList' || type === 'taskList') {
      if (content.length === 0) return null;
    }
    if (type === 'listItem' || type === 'taskItem') {
      // content expression "paragraph block*": a list item always starts with a paragraph
      if (content[0]?.type !== 'paragraph') {
        this.budget.nodes += 1;
        content = [{ type: 'paragraph' }, ...content];
      }
    }
    if (content.length > 0) node.content = content;
    return node;
  }
}

/**
 * Reduces arbitrary JSON to the content model (spec §6): unknown nodes are unwrapped, unknown marks and
 * attributes dropped, links limited to http/https/mailto, control and bidi characters removed, and
 * depth, node count and text length capped. The result always satisfies the editor schema's structure.
 */
export function sanitizeContent(input: unknown): ContentDoc {
  return new Sanitizer().document(input);
}
