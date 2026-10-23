import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient } from './client';

const session = {
  user: { id: '3f2b1c0e-8f0a-4b8e-9a53-7a1d2f3c4b5d', email: 'a@b.co', name: 'A' },
  accessToken: 't',
  expiresIn: 900,
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = () =>
  reply({ statusCode: 401, code: 'TOKEN_EXPIRED', message: 'expired', correlationId: 'c' }, 401);

describe('api client', () => {
  it('refreshes once on 401 and retries the original request', async () => {
    const calls: string[] = [];
    let first = true;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (String(url) === '/api/auth/refresh') return reply(session);
      if (first) {
        first = false;
        return unauthenticated();
      }
      return reply({ ok: true });
    });
    const client = createApiClient({ fetchImpl });
    const data = await client.request('/workspaces', { schema: z.object({ ok: z.boolean() }) });
    expect(data).toEqual({ ok: true });
    expect(calls).toEqual(['/api/workspaces', '/api/auth/refresh', '/api/workspaces']);
  });

  it('shares one refresh between concurrent 401s (single flight)', async () => {
    let refreshed = false;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/auth/refresh') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        refreshed = true;
        return reply(session);
      }
      return refreshed ? reply({ ok: true }) : unauthenticated();
    });
    const client = createApiClient({ fetchImpl });
    const schema = z.object({ ok: z.boolean() });
    await Promise.all(['/a', '/b', '/c'].map((p) => client.request(p, { schema })));
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url) === '/api/auth/refresh'),
    ).toHaveLength(1);
  });

  it('reports a lost session when the refresh is rejected, without retrying', async () => {
    const onSessionLost = vi.fn();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url) === '/api/auth/refresh' ? unauthenticated() : unauthenticated(),
    );
    const client = createApiClient({ fetchImpl, onSessionLost });
    await expect(client.request('/workspaces')).rejects.toMatchObject({ status: 401 });
    expect(onSessionLost).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries only once when the second attempt is still unauthorised', async () => {
    const onSessionLost = vi.fn();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url) === '/api/auth/refresh' ? reply(session) : unauthenticated(),
    );
    const client = createApiClient({ fetchImpl, onSessionLost });
    await expect(client.request('/workspaces')).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for auth endpoints and sends JSON bodies with a correlation id', async () => {
    const fetchImpl = vi.fn(async () => unauthenticated());
    const client = createApiClient({ fetchImpl });
    await expect(
      client.request('/auth/login', { method: 'POST', body: { a: 1 } }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[1].body).toBe('{"a":1}');
    expect((init[1].headers as Record<string, string>)['x-correlation-id']).toMatch(
      /[0-9a-f-]{36}/,
    );
  });

  it('rejects responses that do not match the schema', async () => {
    const client = createApiClient({ fetchImpl: async () => reply({ ok: 'nope' }) });
    await expect(
      client.request('/x', { schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('wraps network failures', async () => {
    const client = createApiClient({
      fetchImpl: async () => {
        throw new TypeError('failed to fetch');
      },
    });
    await expect(client.request('/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
