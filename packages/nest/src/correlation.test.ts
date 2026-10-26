import { describe, expect, it } from 'vitest';
import { getCorrelationId, resolveCorrelationId, runWithCorrelationId } from './correlation';

describe('correlation id', () => {
  it('keeps a safe incoming id', () => {
    expect(resolveCorrelationId('abc-123_DEF.456')).toBe('abc-123_DEF.456');
    expect(resolveCorrelationId(['abc-123_DEF.456', 'other'])).toBe('abc-123_DEF.456');
  });

  it('generates a uuid for missing, short, long or unsafe ids', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const raw of [
      undefined,
      '',
      'short',
      'x'.repeat(200),
      'has space in it',
      'new\nline-injection',
      42,
    ]) {
      expect(resolveCorrelationId(raw)).toMatch(uuid);
    }
  });

  it('is available across awaits inside runWithCorrelationId and isolated between runs', async () => {
    const read = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return getCorrelationId();
    };
    const [a, b] = await Promise.all([
      runWithCorrelationId('corr-aaaaaaaa', read),
      runWithCorrelationId('corr-bbbbbbbb', read),
    ]);
    expect([a, b]).toEqual(['corr-aaaaaaaa', 'corr-bbbbbbbb']);
    expect(getCorrelationId()).toBeUndefined();
  });
});
