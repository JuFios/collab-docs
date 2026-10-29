import { type APIResponse, expect, test } from '@playwright/test';

// Rate limits (login, register, public links) are keyed on the client address, so a client must not be
// able to choose it. The proxy overwrites X-Forwarded-For, and the api trusts the header only from the proxy and
// web, not from the gateway that its own published port (development only) is reached through.
const API_DIRECT = `http://localhost:${process.env.API_PORT ?? '4000'}`;

test.describe('client address', () => {
  for (const [route, url] of [
    ['through the proxy', '/api/auth/login'],
    ['straight to the api port', `${API_DIRECT}/api/auth/login`],
  ] as const) {
    test(`a spoofed X-Forwarded-For does not give a fresh rate-limit bucket (${route})`, async ({
      request,
    }) => {
      await expectOneBucket((spoofed) =>
        request.post(url, {
          data: { email: `nobody-${Date.now()}@example.test`, password: 'irrelevant-password' },
          headers: { 'x-forwarded-for': spoofed },
        }),
      );
    });
  }
});

async function expectOneBucket(attempt: (spoofed: string) => Promise<APIResponse>) {
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
}
