/**
 * The allowlist behind every piece of document content (spec §6), kept as plain data so that the editor
 * configuration (Tiptap), the sanitiser, the published page and the search index all agree on it.
 */

/** Name of the `Y.XmlFragment` that holds the document body inside a `Y.Doc`. */
export const CONTENT_FIELD = 'content';

export const BLOCK_NODES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'image',
  'codeBlock',
] as const;
export const INLINE_NODES = ['hardBreak', 'mention'] as const;
export const NODE_NAMES = [
  'doc',
  ...BLOCK_NODES,
  'listItem',
  'taskItem',
  ...INLINE_NODES,
  'text',
] as const;
export const MARK_NAMES = ['bold', 'italic', 'code', 'link'] as const;

export type BlockNodeName = (typeof BLOCK_NODES)[number];
export type NodeName = (typeof NODE_NAMES)[number];
export type MarkName = (typeof MARK_NAMES)[number];

/** Languages a code block may declare; anything else is dropped (the block stays, highlighted as plain text). */
export const CODE_LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'dockerfile',
  'go',
  'html',
  'java',
  'javascript',
  'json',
  'jsx',
  'kotlin',
  'markdown',
  'php',
  'plaintext',
  'python',
  'ruby',
  'rust',
  'shell',
  'sql',
  'swift',
  'tsx',
  'typescript',
  'yaml',
] as const;

export const LINK_PROTOCOLS = ['http:', 'https:', 'mailto:'] as const;
/** `rel` forced onto every link (user-generated content). */
export const LINK_REL = 'noopener noreferrer nofollow ugc';

export type AttrSpec =
  /** Stable id of a block (comment anchors); optional. */
  | { kind: 'blockId' }
  | { kind: 'uuid'; required: boolean }
  | { kind: 'text'; maxLength: number }
  | { kind: 'int'; min: number; max: number; default: number }
  | { kind: 'bool'; default: boolean }
  | { kind: 'enum'; values: readonly string[] };

const blockId: AttrSpec = { kind: 'blockId' };

export interface NodeSpecData {
  /** ProseMirror content expression; the editor schema and the tests are built from it. */
  content: string;
  /** `block`/`inline` group in the ProseMirror schema. */
  group?: 'block' | 'inline';
  /** Node types allowed as direct children (the sanitiser enforces it). */
  children: readonly NodeName[];
  /** Marks allowed on text inside; `none` for code blocks. */
  marks: 'all' | 'none';
  atom?: boolean;
  attrs: Readonly<Record<string, AttrSpec>>;
}

const BLOCKS: readonly NodeName[] = BLOCK_NODES;
const INLINE: readonly NodeName[] = ['text', ...INLINE_NODES];

export const NODE_SPECS: Readonly<Record<Exclude<NodeName, 'text'>, NodeSpecData>> = {
  doc: { content: 'block+', children: BLOCKS, marks: 'all', attrs: {} },
  paragraph: {
    content: 'inline*',
    group: 'block',
    children: INLINE,
    marks: 'all',
    attrs: { id: blockId },
  },
  heading: {
    content: 'inline*',
    group: 'block',
    children: INLINE,
    marks: 'all',
    attrs: { id: blockId, level: { kind: 'int', min: 1, max: 3, default: 1 } },
  },
  bulletList: {
    content: 'listItem+',
    group: 'block',
    children: ['listItem'],
    marks: 'all',
    attrs: { id: blockId },
  },
  orderedList: {
    content: 'listItem+',
    group: 'block',
    children: ['listItem'],
    marks: 'all',
    attrs: { id: blockId, start: { kind: 'int', min: 1, max: 1_000_000, default: 1 } },
  },
  listItem: {
    content: 'paragraph block*',
    children: BLOCKS,
    marks: 'all',
    attrs: { id: blockId },
  },
  taskList: {
    content: 'taskItem+',
    group: 'block',
    children: ['taskItem'],
    marks: 'all',
    attrs: { id: blockId },
  },
  taskItem: {
    content: 'paragraph block*',
    children: BLOCKS,
    marks: 'all',
    attrs: { id: blockId, checked: { kind: 'bool', default: false } },
  },
  image: {
    content: '',
    group: 'block',
    atom: true,
    children: [],
    marks: 'none',
    attrs: {
      id: blockId,
      attachmentId: { kind: 'uuid', required: true },
      alt: { kind: 'text', maxLength: 500 },
    },
  },
  codeBlock: {
    content: 'text*',
    group: 'block',
    children: ['text'],
    marks: 'none',
    attrs: { id: blockId, language: { kind: 'enum', values: CODE_LANGUAGES } },
  },
  hardBreak: { content: '', group: 'inline', atom: true, children: [], marks: 'none', attrs: {} },
  mention: {
    content: '',
    group: 'inline',
    atom: true,
    children: [],
    marks: 'none',
    attrs: {
      id: { kind: 'uuid', required: true },
      label: { kind: 'text', maxLength: 100 },
    },
  },
};

/** Limits applied by the sanitiser so that hostile or corrupted documents cannot exhaust a renderer. */
export const CONTENT_LIMITS = {
  /** Nesting of kept nodes (lists inside lists, ...). */
  maxDepth: 20,
  maxNodes: 50_000,
  /** Total characters of text in the document. */
  maxTextLength: 1_000_000,
  maxHrefLength: 2048,
  /** Recursion guard over the raw input, counting nodes that get unwrapped as well. */
  maxRawDepth: 100,
} as const;

export const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export { UUID_PATTERN } from '../ids';
