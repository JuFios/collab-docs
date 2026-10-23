import { describe, expect, it } from 'vitest';
import { jwtRoundTrip } from '@collab-docs/shared';

describe('web', () => {
  it('loads @collab-docs/shared and its ESM-only jose dependency', async () => {
    await expect(jwtRoundTrip('user-1')).resolves.toBe('user-1');
  });
});
