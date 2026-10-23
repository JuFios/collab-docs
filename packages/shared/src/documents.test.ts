import { describe, expect, it } from 'vitest';
import { positionBetween } from './fractional';
import { canManageDocument, createsCycle } from './permissions';

describe('positionBetween', () => {
  it('appends, prepends and inserts in order', () => {
    const first = positionBetween(null, null);
    const second = positionBetween(first, null);
    const zeroth = positionBetween(null, first);
    const middle = positionBetween(first, second);
    expect([zeroth, first, middle, second]).toEqual([zeroth, first, middle, second].sort());
    expect(new Set([zeroth, first, middle, second]).size).toBe(4);
  });

  it('keeps splitting the same gap without a rebalance', () => {
    let low = positionBetween(null, null);
    const high = positionBetween(low, null);
    for (let i = 0; i < 200; i++) {
      const mid = positionBetween(low, high);
      expect(mid > low && mid < high).toBe(true);
      low = mid;
    }
  });

  it('rejects equal neighbours', () => {
    const key = positionBetween(null, null);
    expect(() => positionBetween(key, key)).toThrow();
  });
});

describe('createsCycle', () => {
  it('allows the root and unrelated parents', () => {
    expect(createsCycle('a', null, [])).toBe(false);
    expect(createsCycle('a', 'b', ['b', 'c'])).toBe(false);
  });

  it('rejects the document itself and its descendants', () => {
    expect(createsCycle('a', 'a', ['a'])).toBe(true);
    // new parent d sits below a: d -> c -> a
    expect(createsCycle('a', 'd', ['d', 'c', 'a'])).toBe(true);
  });
});

describe('canManageDocument', () => {
  it.each([
    ['MANAGE', false, true],
    ['EDIT', true, true],
    ['EDIT', false, false],
    ['VIEW', true, false],
    ['NONE', true, false],
  ] as const)('%s, author=%s -> %s', (access, author, expected) => {
    expect(canManageDocument(access, author)).toBe(expected);
  });
});
