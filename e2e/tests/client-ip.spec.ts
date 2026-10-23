import { expect, test } from '@playwright/test';

// Rate limits (login, register, public links) are keyed on the client address, so a client must not be
// able to choose it. The proxy overwrites X-Forwarded-For; a spoofed value must land in the same bucket.
test.describe('client address', () => {
  test('a spoofed X-Forwarded-For does not give a fresh rate-limit bucket', async ({ request }) => {
    const attempt = (spoofed: string) =>
      request.post('/api/auth/login', {
        data: { email: `nobody-${Date.now()}@example.test`, password: 'irrelevant-password' },
        headers: { 'x-forwarded-for': spoofed },
      });
    const remaining = async (spoofed: string) => {
      const response = await attempt(spoofed);
      expect(response.status()).toBe(401);
      return Number(response.headers()['x-ratelimit-remaining']);
    };

    const first = await remaining('203.0.113.1');
    const second = await remaining('203.0.113.2');
    const third = await remaining('203.0.113.3');
    expect(second).toBeLessThan(first);
    expect(third).toBeLessThan(second);
  });
});
