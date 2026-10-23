import { describe, expect, it } from 'vitest';
import { formatBytes, formatRelative } from './labels';

const NOW = new Date('2026-10-23T12:00:00Z');

describe('formatRelative', () => {
  it.each([
    ['2026-10-23T11:59:40Z', 'just now'],
    ['2026-10-23T11:59:00Z', '1 minute ago'],
    ['2026-10-23T11:15:00Z', '45 minutes ago'],
    ['2026-10-23T09:00:00Z', '3 hours ago'],
    ['2026-10-20T12:00:00Z', '3 days ago'],
  ])('%s -> %s', (iso, expected) => {
    expect(formatRelative(iso, NOW)).toBe(expected);
  });

  it('falls back to a date after a month and to nothing for garbage', () => {
    expect(formatRelative('2026-08-01T12:00:00Z', NOW)).toBe('Aug 1, 2026');
    expect(formatRelative('nope', NOW)).toBe('');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1536, '1.5 KB'],
    [100 * 1024 * 1024, '100 MB'],
    [5 * 1024 ** 3, '5 GB'],
  ])('%i -> %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
