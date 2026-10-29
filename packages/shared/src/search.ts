import { z } from 'zod';

export const SEARCH_QUERY_MAX_LENGTH = 200;
/** Words beyond these limits are ignored: every word is one more term for the index to intersect. */
export const SEARCH_MAX_TOKENS = 8;
export const SEARCH_TOKEN_MAX_LENGTH = 50;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

/** Control characters that the api puts around a match in a snippet. Text never contains them (see `plainSearchText`). */
export const SNIPPET_MATCH_START = '\u0001';
export const SNIPPET_MATCH_END = '\u0002';
/**
 * Stands in for `<` in indexed text. The Postgres parser reads `<div>` or `<script ...>` as an HTML tag and drops
 * it from both the vector and `ts_headline`, so such text (code, a pasted snippet) could be neither found nor shown.
 * To the parser a control character only separates words, and indexed text has no other (see `plainSearchText`);
 * `parseSnippet` turns it back into `<`.
 */
export const INDEXED_LESS_THAN = '\u0003';

const TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * The words of a search query: letters and digits only, so nothing a user types can reach the `tsquery` syntax
 * (`& | ! ( ) : * < > '` and the rest are separators). At most {@link SEARCH_MAX_TOKENS} distinct words, each cut
 * to {@link SEARCH_TOKEN_MAX_LENGTH}. An empty array means "nothing to search for".
 */
export function tokenizeSearchQuery(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const [word] of query.normalize('NFC').matchAll(TOKEN)) {
    const token = word.slice(0, SEARCH_TOKEN_MAX_LENGTH);
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
    if (tokens.length === SEARCH_MAX_TOKENS) break;
  }
  return tokens;
}

/**
 * Text as it is indexed: whitespace runs collapse to one space, control characters (a NUL cannot be stored in
 * Postgres; the snippet delimiters must not occur in the text) become spaces and `<` becomes
 * {@link INDEXED_LESS_THAN}.
 */
export function plainSearchText(text: string): string {
  return text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll('<', INDEXED_LESS_THAN);
}

export interface SnippetPart {
  text: string;
  match: boolean;
}

/**
 * Splits the output of `ts_headline` (matches wrapped in {@link SNIPPET_MATCH_START} / {@link SNIPPET_MATCH_END})
 * into plain parts, so a client can render matches as elements without ever treating text as HTML. Unbalanced
 * delimiters are tolerated; adjacent parts of the same kind are merged.
 */
export function parseSnippet(raw: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let match = false;
  let text = '';
  const flush = () => {
    if (text === '') return;
    const last = parts.at(-1);
    if (last?.match === match) last.text += text;
    else parts.push({ text, match });
    text = '';
  };
  for (const char of raw) {
    if (char === SNIPPET_MATCH_START || char === SNIPPET_MATCH_END) {
      flush();
      match = char === SNIPPET_MATCH_START;
    } else {
      text += char === INDEXED_LESS_THAN ? '<' : char;
    }
  }
  flush();
  return parts;
}

export const snippetPartSchema = z.object({ text: z.string(), match: z.boolean() });

export const searchResultSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  title: z.string(),
  snippet: z.array(snippetPartSchema),
  updatedAt: z.string(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

/** One page of results, best match first; pass `nextCursor` back as `cursor` for the next page. */
export const searchPageSchema = z.object({
  items: z.array(searchResultSchema),
  nextCursor: z.string().nullable(),
});
export type SearchPage = z.infer<typeof searchPageSchema>;
