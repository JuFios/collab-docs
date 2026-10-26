import { describe, expect, it } from 'vitest';
import { nextFocus } from './keyboard';

describe('nextFocus', () => {
  it('goes from the field into the list and down it', () => {
    expect(nextFocus('ArrowDown', null, 3)).toBe(0);
    expect(nextFocus('ArrowDown', 0, 3)).toBe(1);
    expect(nextFocus('ArrowDown', 1, 3)).toBe(2);
  });

  it('stays on the last result and when there are no results', () => {
    expect(nextFocus('ArrowDown', 2, 3)).toBeNull();
    expect(nextFocus('ArrowDown', null, 0)).toBeNull();
  });

  it('goes up and back to the field from the first result', () => {
    expect(nextFocus('ArrowUp', 2, 3)).toBe(1);
    expect(nextFocus('ArrowUp', 0, 3)).toBe('input');
    expect(nextFocus('ArrowUp', null, 3)).toBeNull();
  });

  it('returns to the field on Escape from a result only', () => {
    expect(nextFocus('Escape', 1, 3)).toBe('input');
    expect(nextFocus('Escape', null, 3)).toBeNull();
  });

  it('ignores other keys', () => {
    expect(nextFocus('Enter', 1, 3)).toBeNull();
    expect(nextFocus('a', null, 3)).toBeNull();
  });
});
