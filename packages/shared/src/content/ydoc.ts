import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { CONTENT_FIELD } from './schema';
import type { ContentDoc } from './types';

/**
 * Reads the document body as ProseMirror JSON from the `content` fragment (the field the editor's
 * Collaboration extension writes to). The result is **not** sanitised: pass it through `sanitizeContent`
 * before it leaves the server.
 */
export function yDocToContentJson(doc: Y.Doc): ContentDoc {
  return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(CONTENT_FIELD)) as ContentDoc;
}
