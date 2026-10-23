import { beforeEach, describe, expect, it, vi } from 'vitest';

const incoming = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => 'cd_at=access' }),
  headers: async () => ({ get: (name: string) => incoming.get(name) ?? null }),
}));

describe('server api client', () => {
  beforeEach(() => {
    incoming.clear();
    process.env.API_INTERNAL_URL = 'http://api.internal:4000/';
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    vi.restoreAllMocks();
  });

  it('forwards cookies, client IP, correlation id and Origin to the api', async () => {
    incoming.set('x-forwarded-for', '203.0.113.9');
    incoming.set('x-correlation-id', 'corr-1');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { apiServer } = await import('./server');
    const { z } = await import('zod');
    await expect(apiServer('/thing', { schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({
      ok: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.internal:4000/api/thing');
    const headers = init.headers as Headers;
    expect(headers.get('cookie')).toBe('cd_at=access');
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9');
    expect(headers.get('x-correlation-id')).toBe('corr-1');
    expect(headers.get('origin')).toBe('http://localhost:3000');
    expect(init.cache).toBe('no-store');
  });

  it('turns api errors into ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ statusCode: 404, code: 'NOT_FOUND', message: 'gone', correlationId: 'c' }),
        { status: 404 },
      ),
    );
    const { apiServer } = await import('./server');
    await expect(apiServer('/missing')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
