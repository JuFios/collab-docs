import { describe, expect, it } from 'vitest';
import { sanitizeNextPath } from './next-path';

describe('sanitizeNextPath', () => {
  it('keeps relative paths with query and hash', () => {
    expect(sanitizeNextPath('/workspaces/abc?tab=1#x')).toBe('/workspaces/abc?tab=1#x');
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
    expect(sanitizeNextPath(value)).toBe('/workspaces');
  });

  it('falls back for missing values and honours a custom fallback', () => {
    expect(sanitizeNextPath(undefined)).toBe('/workspaces');
    expect(sanitizeNextPath(null, '/')).toBe('/');
  });
});
