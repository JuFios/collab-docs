import { describe, expect, it } from 'vitest';
import { findMentionTrigger, insertMention, serializeBody, splitBody } from './mentions';

const ANN = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ALEX_1 = '33333333-3333-4333-8333-333333333333';
const ALEX_2 = '44444444-4444-4444-8444-444444444444';

describe('findMentionTrigger', () => {
  it.each([
    ['@', 1, ''],
    ['hi @an', 6, 'an'],
    ['line one\n@Bo', 12, 'Bo'],
  ])('finds the query in %j', (text, caret, query) => {
    expect(findMentionTrigger(text, caret)).toEqual({ start: text.lastIndexOf('@'), query });
  });

  it.each([
    ['mail me at a@b', 14],
    ['@Ann said hi', 12],
    ['no mention', 10],
    ['a.@x', 4],
  ])('finds nothing in %j', (text, caret) => {
    expect(findMentionTrigger(text, caret)).toBeNull();
  });

  it('only looks at the text before the caret', () => {
    expect(findMentionTrigger('hi @an and more', 6)).toEqual({ start: 3, query: 'an' });
  });
});

describe('insertMention', () => {
  it('replaces the query with the name and moves the caret past it', () => {
    const text = 'hi @an and more';
    const trigger = findMentionTrigger(text, 6)!;
    expect(insertMention(text, trigger, 6, 'Ann Lee')).toEqual({
      text: 'hi @Ann Lee  and more',
      caret: 12,
    });
  });
});

describe('serializeBody', () => {
  it('turns picked names into tokens', () => {
    expect(
      serializeBody('Thanks @Ann Lee and @Bob!', [
        { id: ANN, name: 'Ann Lee' },
        { id: BOB, name: 'Bob' },
      ]),
    ).toBe(`Thanks @[${ANN}] and @[${BOB}]!`);
  });

  it('leaves text that was not picked alone', () => {
    expect(serializeBody('cc @Carl', [{ id: ANN, name: 'Ann' }])).toBe('cc @Carl');
  });

  it('prefers the longest name and respects word boundaries', () => {
    const picked = [
      { id: ANN, name: 'Ann' },
      { id: BOB, name: 'Ann Lee' },
    ];
    expect(serializeBody('@Ann Lee and @Anna and @Ann', picked)).toBe(
      `@[${BOB}] and @Anna and @[${ANN}]`,
    );
  });

  it('forgets a mention whose text was deleted', () => {
    expect(serializeBody('nobody here', [{ id: ANN, name: 'Ann' }])).toBe('nobody here');
  });

  it('matches two people with the same name in the order they were picked', () => {
    const picked = [
      { id: ALEX_1, name: 'Alex' },
      { id: ALEX_2, name: 'Alex' },
    ];
    expect(serializeBody('@Alex then @Alex then @Alex', picked)).toBe(
      `@[${ALEX_1}] then @[${ALEX_2}] then @Alex`,
    );
  });

  it('escapes regular expression characters in names', () => {
    expect(serializeBody('@A.(b)+', [{ id: ANN, name: 'A.(b)+' }])).toBe(`@[${ANN}]`);
  });

  it('does not treat an email address as a mention', () => {
    expect(serializeBody('write to x@Ann', [{ id: ANN, name: 'Ann' }])).toBe('write to x@Ann');
  });
});

describe('splitBody', () => {
  it('shows listed users by name and everyone else as "someone"', () => {
    expect(splitBody(`hi @[${ANN}] and @[${BOB}]`, [{ userId: ANN, name: 'Ann' }])).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'mention', userId: ANN, name: 'Ann' },
      { type: 'text', text: ' and ' },
      { type: 'mention', userId: BOB, name: 'someone' },
    ]);
  });

  it('keeps markup-looking text as plain text parts', () => {
    expect(splitBody('<img src=x onerror=alert(1)>', [])).toEqual([
      { type: 'text', text: '<img src=x onerror=alert(1)>' },
    ]);
  });
});
