import { describe, expect, it } from 'vitest';
import { collectPresence, initialsOf } from './presence';

describe('collectPresence', () => {
  it('lists others once, without the local client and without malformed states', () => {
    const states = new Map<number, unknown>([
      [1, { user: { id: 'me', name: 'Me', color: '#111111' } }],
      [2, { user: { id: 'u2', name: 'Ada Lovelace', color: '#222222' }, cursor: null }],
      [3, { user: { id: 'u2', name: 'Ada Lovelace', color: '#222222' } }],
      [4, { cursor: null }],
      [5, { user: { id: 'u5', name: 7 } }],
      [6, { user: { id: 'guest-1', name: 'Guest', color: '#333333' } }],
    ]);
    expect(collectPresence(states, 1).map((user) => user.id)).toEqual(['u2', 'guest-1']);
  });
});

describe('initialsOf', () => {
  it('uses the first and last word', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('Ada Augusta King')).toBe('AK');
    expect(initialsOf('ada')).toBe('A');
    expect(initialsOf('')).toBe('?');
  });
});
