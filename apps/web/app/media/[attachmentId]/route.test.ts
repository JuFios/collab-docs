import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const ID = '0192f4a8-7a3b-7c11-9d4e-5b2a1c3d4e5f';

const call = (id: string, query: string) =>
  GET(new Request(`http://web/media/${id}${query}`), { params: Promise.resolve({ id }) });

describe('GET /media/:id', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes the signed URL of the api on as a redirect, without following it', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://s3/bucket/key?sig=1' } }),
      );
    const response = await call(ID, '?slug=plan-3fa9c1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://s3/bucket/key?sig=1');
    expect(response.headers.get('cache-control')).toContain('max-age=120');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/public/media/${ID}?slug=plan-3fa9c1`);
    expect(init.redirect).toBe('manual');
    expect(init.headers).not.toHaveProperty('cookie');
  });

  it.each([
    ['an id that is not a uuid', 'not-an-id', '?slug=plan-3fa9c1'],
    ['no slug', ID, ''],
    ['a slug of the wrong shape', ID, '?slug=Bad%20Slug'],
  ])('answers 404 for %s without asking the api', async (_label, id, query) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect((await call(id, query)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 404 when the api does, and never redirects somewhere else than http(s)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await call(ID, '?slug=plan-3fa9c1')).status).toBe(404);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'javascript:alert(1)' } }),
    );
    expect((await call(ID, '?slug=plan-3fa9c1')).status).toBe(502);
  });

  it('answers 502 when the api cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    expect((await call(ID, '?slug=plan-3fa9c1')).status).toBe(502);
  });
});
