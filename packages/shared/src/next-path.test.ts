import { describe, expect, it } from 'vitest';
import { sanitizeNextPath } from './next-path';

describe('sanitizeNextPath', () => {
  it('keeps relative paths with query and hash', () => {
    expect(sanitizeNextPath('/w/abc?tab=1#x')).toBe('/w/abc?tab=1#x');
  });

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    '/ok\nLocation: x',
    'w/relative',
    '',
  ])('rejects %j', (value) => {
    expect(sanitizeNextPath(value)).toBe('/w');
  });

  it('falls back for missing values and honours a custom fallback', () => {
    expect(sanitizeNextPath(undefined)).toBe('/w');
    expect(sanitizeNextPath(null, '/')).toBe('/');
  });
});
