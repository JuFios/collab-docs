import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { type AttrSpec, CONTENT_FIELD, LINK_REL, NODE_SPECS } from './schema';
import type { ContentNode } from './types';

function defaultOf(spec: AttrSpec): unknown {
  switch (spec.kind) {
    case 'int':
    case 'bool':
      return spec.default;
    case 'text':
      return '';
    default:
      return null;
  }
}

/**
 * The content model as a ProseMirror schema, built from the shared allowlist. The editor uses Tiptap
 * extensions with the same node and mark names; this schema serves the server (tests, version restore).
 */
export function createContentSchema(): Schema {
  const nodes: Record<string, NodeSpec> = { text: { group: 'inline' } };
  for (const [name, spec] of Object.entries(NODE_SPECS)) {
    const attrs: Record<string, { default: unknown }> = {};
    for (const [key, attr] of Object.entries(spec.attrs)) attrs[key] = { default: defaultOf(attr) };
    const node: NodeSpec = { content: spec.content || undefined, attrs };
    if (spec.group) node.group = spec.group;
    if (spec.group === 'inline') node.inline = true;
    if (spec.atom) node.atom = true;
    if (name === 'codeBlock') {
      node.marks = '';
      node.code = true;
    }
    nodes[name] = node;
  }
  const marks: Record<string, MarkSpec> = {
    bold: {},
    italic: {},
    code: {},
    link: { attrs: { href: {}, rel: { default: LINK_REL } }, inclusive: false },
  };
  return new Schema({ nodes, marks, topNode: 'doc' });
}

/** Builds a `Y.Doc` holding `json` in the `content` fragment (the shape the editor's Collaboration extension reads). */
export function contentJsonToYDoc(
  json: ContentNode,
  schema: Schema = createContentSchema(),
): Y.Doc {
  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(schema, json, doc.getXmlFragment(CONTENT_FIELD));
  return doc;
}
