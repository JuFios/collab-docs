import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('next/headers', () => ({
  cookies: () => {
    throw new Error('public client must not read cookies');
  },
  headers: () => {
    throw new Error('public client must not read headers');
  },
}));

describe('public api client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends no cookies or forwarded headers and passes ISR options through', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ title: 'Doc' }), { status: 200 }));
    const { apiPublic } = await import('./public');
    await apiPublic('/public/x', {
      schema: z.object({ title: z.string() }),
      next: { revalidate: 3600, tags: ['p:x'] },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { next?: unknown }];
    expect(Object.keys(init.headers as object)).toEqual(['accept']);
    expect(init.next).toEqual({ revalidate: 3600, tags: ['p:x'] });
  });
});
