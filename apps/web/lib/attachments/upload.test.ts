import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { validateImageFile } from './upload';

const file = (name: string, type: string, size = 10) =>
  new File([new Uint8Array(size)], name, { type });

describe('validateImageFile', () => {
  it('accepts the allowed raster types', () => {
    expect(validateImageFile(file('a.png', 'image/png'))).toBe('image/png');
    expect(validateImageFile(file('a.JPG', 'image/jpeg'))).toBe('image/jpeg');
  });

  it.each([
    ['a.svg', 'image/svg+xml'],
    ['a.txt', 'text/plain'],
    ['a.png', 'image/jpeg'],
    ['image', 'image/png'],
  ])('refuses %s as %s', (name, type) => {
    expect(() => validateImageFile(file(name, type))).toThrow(ApiError);
  });

  it('refuses an empty file', () => {
    expect(() => validateImageFile(file('a.png', 'image/png', 0))).toThrow(ApiError);
  });
});
