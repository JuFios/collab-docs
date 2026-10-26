import { describe, expect, it } from 'vitest';
import {
  BLOCK_ID_FORMAT,
  MAX_MENTIONS_PER_COMMENT,
  NOTIFICATION_EXCERPT_LENGTH,
  commentExcerpt,
  parseMentions,
  stripMentions,
} from './comments';
import { BLOCK_ID_PATTERN } from './content/schema';

const A = '0198d6c0-0000-7000-8000-00000000000a';
const B = '0198d6c0-0000-7000-8000-00000000000b';

describe('parseMentions', () => {
  it('finds well-formed tokens in order, once each, lower-cased', () => {
    const upper = A.toUpperCase();
    const body = `hi @[${A}] and @[${B}] and again @[${upper}]`;
    expect(parseMentions(body)).toEqual({ userIds: [A, B], overflow: [] });
  });

  it('ignores anything that is not a well-formed token', () => {
    const body = [
      '@[not-a-uuid]',
      `@${A}`,
      `[${A}]`,
      `@[${A} ]`,
      `@[${A}`,
      "@[1'; DROP TABLE users;--]",
      '@[<script>alert(1)</script>]',
      '@everyone',
    ].join(' ');
    expect(parseMentions(body).userIds).toEqual([]);
  });

  it('keeps a token glued to punctuation', () => {
    expect(parseMentions(`(@[${A}]),@[${B}].`).userIds).toEqual([A, B]);
  });

  it('caps the number of mentions and reports the rest', () => {
    const ids = Array.from(
      { length: MAX_MENTIONS_PER_COMMENT + 3 },
      (_, i) => `0198d6c0-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    const parsed = parseMentions(ids.map((id) => `@[${id}]`).join(' '));
    expect(parsed.userIds).toEqual(ids.slice(0, MAX_MENTIONS_PER_COMMENT));
    expect(parsed.overflow).toEqual(ids.slice(MAX_MENTIONS_PER_COMMENT));
  });

  it('handles an empty body', () => {
    expect(parseMentions('')).toEqual({ userIds: [], overflow: [] });
  });
});

describe('stripMentions', () => {
  it('removes only the listed users', () => {
    const body = `a @[${A}] b @[${B}] c`;
    expect(stripMentions(body, new Set([A]))).toBe(`a  b @[${B}] c`);
    expect(stripMentions(body, new Set())).toBe(body);
  });

  it('matches ids case-insensitively', () => {
    expect(stripMentions(`x @[${A.toUpperCase()}]`, new Set([A]))).toBe('x ');
  });
});

describe('commentExcerpt', () => {
  it('replaces tokens with names and collapses whitespace and control characters', () => {
    const names = new Map([[A, 'Ann']]);
    expect(commentExcerpt(`hey\n\n @[${A}]\t \u0007thanks @[${B}]`, names)).toBe(
      'hey @Ann thanks @someone',
    );
  });

  it('cuts long text at the limit, by characters, ending with an ellipsis', () => {
    const excerpt = commentExcerpt('é'.repeat(500), new Map());
    expect([...excerpt]).toHaveLength(NOTIFICATION_EXCERPT_LENGTH);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('leaves markup as text (escaping is the renderer’s job)', () => {
    expect(commentExcerpt('<img src=x onerror=alert(1)>', new Map())).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });
});

describe('BLOCK_ID_FORMAT', () => {
  it('is the pattern of the content model', () => {
    expect(BLOCK_ID_FORMAT.source).toBe(BLOCK_ID_PATTERN.source);
  });
});
