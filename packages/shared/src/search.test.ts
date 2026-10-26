import { describe, expect, it } from 'vitest';
import {
  SEARCH_MAX_TOKENS,
  SEARCH_TOKEN_MAX_LENGTH,
  parseSnippet,
  plainSearchText,
  searchPageSchema,
  tokenizeSearchQuery,
} from './search';

describe('tokenizeSearchQuery', () => {
  it.each([
    ['plain words', 'quarterly plan', ['quarterly', 'plan']],
    ['an injection attempt', "'; DROP TABLE documents; --", ['DROP', 'TABLE', 'documents']],
    ['every tsquery operator', '&|!<->:*()\\\'"', []],
    ['operators between words', 'a&b|c!d<->e:*f', ['a', 'b', 'c', 'd', 'e', 'f']],
    ['an empty query', '', []],
    ['only whitespace', ' \t\n ', []],
    ['accents are kept for the database to fold', 'Café Zürich', ['Café', 'Zürich']],
    ['cyrillic', 'Привіт, світе! Їжак', ['Привіт', 'світе', 'Їжак']],
    ['digits', 'v2 2026-10', ['v2', '2026', '10']],
    ['a decomposed accent is composed first', 'café', ['café']],
    ['case-insensitive duplicates', 'Plan plan PLAN', ['Plan']],
  ])('%s', (_label, query, expected) => {
    expect(tokenizeSearchQuery(query)).toEqual(expected);
  });

  it('keeps the first words only', () => {
    const query = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    expect(tokenizeSearchQuery(query)).toEqual(
      Array.from({ length: SEARCH_MAX_TOKENS }, (_, i) => `w${i}`),
    );
  });

  it('cuts a long word', () => {
    const [token] = tokenizeSearchQuery('x'.repeat(500));
    expect(token).toHaveLength(SEARCH_TOKEN_MAX_LENGTH);
  });

  it('never returns a character that has a meaning in a tsquery', () => {
    const tokens = tokenizeSearchQuery("a:* & b' | !(c) <-> \\d");
    for (const token of tokens) expect(token).toMatch(/^[\p{L}\p{N}]+$/u);
  });
});

describe('plainSearchText', () => {
  it('collapses whitespace and replaces control characters (NUL included)', () => {
    expect(plainSearchText('a\u0000b\n\n  c\u0001d\u0002\te ')).toBe('a b c d e');
  });
});

describe('parseSnippet', () => {
  it('splits text around the matches', () => {
    expect(parseSnippet('the \u0001plan\u0002 for \u0001Q4\u0002.')).toEqual([
      { text: 'the ', match: false },
      { text: 'plan', match: true },
      { text: ' for ', match: false },
      { text: 'Q4', match: true },
      { text: '.', match: false },
    ]);
  });

  it('returns the text as it is when nothing matched', () => {
    expect(parseSnippet('no matches here')).toEqual([{ text: 'no matches here', match: false }]);
  });

  it('is empty for an empty string', () => {
    expect(parseSnippet('')).toEqual([]);
  });

  it('does not interpret markup: it is plain text for the client to render', () => {
    expect(parseSnippet('<img src=x onerror=alert(1)> \u0001<b>x</b>\u0002')).toEqual([
      { text: '<img src=x onerror=alert(1)> ', match: false },
      { text: '<b>x</b>', match: true },
    ]);
  });

  it('tolerates unbalanced delimiters', () => {
    expect(parseSnippet('\u0001a\u0001b\u0002c\u0002d')).toEqual([
      { text: 'ab', match: true },
      { text: 'cd', match: false },
    ]);
    expect(parseSnippet('\u0002\u0002x\u0001')).toEqual([{ text: 'x', match: false }]);
  });

  it('keeps characters outside the BMP whole', () => {
    expect(parseSnippet('a \u0001😀\u0002')).toEqual([
      { text: 'a ', match: false },
      { text: '😀', match: true },
    ]);
  });
});

describe('searchPageSchema', () => {
  it('accepts a page', () => {
    expect(
      searchPageSchema.safeParse({
        items: [
          {
            id: '0190b1c2-0000-7000-8000-0000000000aa',
            title: 'Plan',
            snippet: [{ text: 'x', match: true }],
            updatedAt: '2026-10-26T12:00:00.000Z',
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });
});
