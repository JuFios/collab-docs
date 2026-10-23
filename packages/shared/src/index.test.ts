import { describe, expect, it } from 'vitest';
import { jwtRoundTrip } from './index';

describe('shared', () => {
  it('signs and verifies a token with jose', async () => {
    await expect(jwtRoundTrip('user-1')).resolves.toBe('user-1');
  });
});
