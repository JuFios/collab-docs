import { describe, expect, it } from 'vitest';
import { PLAN_CATALOG, storageFits } from './plans';

describe('storageFits', () => {
  const limit = PLAN_CATALOG.FREE.maxStorageBytes;

  it('allows an upload that lands exactly on the limit', () => {
    expect(storageFits('FREE', limit - 10, 10)).toBe(true);
    expect(storageFits('FREE', 0, limit)).toBe(true);
  });

  it('refuses one byte more', () => {
    expect(storageFits('FREE', limit - 10, 11)).toBe(false);
    expect(storageFits('FREE', limit, 1)).toBe(false);
  });

  it('uses the limit of the given plan', () => {
    expect(storageFits('FREE', limit, 1)).toBe(false);
    expect(storageFits('PRO', limit, 1)).toBe(true);
  });
});
