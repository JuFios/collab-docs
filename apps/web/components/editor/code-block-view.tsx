'use client';

import { CODE_LANGUAGES } from '@collab-docs/shared/content';
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

/** A code block with a language picker; the language is the only attribute besides the block id. */
export function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
  return (
    <NodeViewWrapper className="relative my-3">
      <select
        contentEditable={false}
        aria-label="Code language"
        value={language}
        disabled={!editor.isEditable}
        onChange={(event) => updateAttributes({ language: event.target.value || null })}
        className="absolute right-2 top-2 rounded border bg-background px-1 py-0.5 text-xs text-muted-foreground"
      >
        <option value="">Plain text</option>
        {CODE_LANGUAGES.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <pre className="overflow-x-auto rounded-md bg-muted p-4 pr-28 font-mono text-sm">
        <NodeViewContent<'code'> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
