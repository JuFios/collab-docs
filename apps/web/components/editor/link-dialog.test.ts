import { describe, expect, it } from 'vitest';
import { normalizeHref } from './link-dialog';

describe('normalizeHref', () => {
  it('adds https to a bare domain', () => {
    expect(normalizeHref('example.com/page')).toBe('https://example.com/page');
  });

  it('keeps http, https and mailto', () => {
    expect(normalizeHref('http://example.com')).toBe('http://example.com/');
    expect(normalizeHref('mailto:a@example.com')).toBe('mailto:a@example.com');
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', '', '   '])(
    'refuses %j',
    (input) => {
      expect(normalizeHref(input)).toBeNull();
    },
  );
});
