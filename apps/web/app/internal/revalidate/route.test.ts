import { beforeEach, describe, expect, it, vi } from 'vitest';

const revalidateTag = vi.fn();
vi.mock('next/cache', () => ({ revalidateTag }));

const SECRET = 'a-shared-secret';

function post(body: unknown, secret: string | null = SECRET) {
  return new Request('http://web/internal/revalidate', {
    method: 'POST',
    headers: secret === null ? {} : { 'x-revalidate-secret': secret },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /internal/revalidate', () => {
  beforeEach(() => {
    revalidateTag.mockReset();
    vi.stubEnv('REVALIDATE_SECRET', SECRET);
  });

  it('invalidates every tag it is given', async () => {
    const { POST } = await import('./route');
    const response = await POST(post({ tags: ['pub:plan-3fa9c1', 'pub:notes-a1b2c3'] }));
    expect(response.status).toBe(200);
    expect(revalidateTag.mock.calls.map(([tag]) => tag)).toEqual([
      'pub:plan-3fa9c1',
      'pub:notes-a1b2c3',
    ]);
  });

  it.each([
    ['no secret', null],
    ['a wrong secret', 'nope'],
    ['a secret of another length', `${SECRET}-longer`],
    ['an empty secret', ''],
  ])('answers 401 and invalidates nothing with %s', async (_label, secret) => {
    const { POST } = await import('./route');
    const response = await POST(post({ tags: ['pub:plan-3fa9c1'] }, secret));
    expect(response.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['no tags', {}],
    ['an empty list', { tags: [] }],
    ['a tag that is not a published page', { tags: ['user:1'] }],
    ['a slug of the wrong shape', { tags: ['pub:Bad Slug'] }],
    ['more than 20 tags', { tags: Array.from({ length: 21 }, (_v, i) => `pub:page-${i}`) }],
  ])('answers 400 for %s', async (_label, body) => {
    const { POST } = await import('./route');
    expect((await POST(post(body))).status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
