import { describe, expect, it } from 'vitest';
import { EXPIRES_AT_PATTERN } from '@collab-docs/shared';
import { toExpiresAt, toLocalInput } from './expiry';

describe('expiry conversion', () => {
  it('turns a local date into an instant the api accepts', () => {
    const iso = toExpiresAt('2030-06-15T09:30');
    expect(iso).toMatch(EXPIRES_AT_PATTERN);
    expect(new Date(iso as string).getTime()).toBe(new Date('2030-06-15T09:30').getTime());
  });

  it('means "never" for an empty or invalid value', () => {
    expect(toExpiresAt('')).toBeNull();
    expect(toExpiresAt('not a date')).toBeNull();
    expect(toLocalInput(null)).toBe('');
  });

  it('round-trips through the input', () => {
    expect(toLocalInput(toExpiresAt('2030-06-15T09:30'))).toBe('2030-06-15T09:30');
  });
});
