/** ProseMirror JSON as stored in the CRDT and as served to readers. */
export interface ContentMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ContentNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ContentNode[];
  marks?: ContentMark[];
  text?: string;
}

export interface ContentDoc extends ContentNode {
  type: 'doc';
  content: ContentNode[];
}
