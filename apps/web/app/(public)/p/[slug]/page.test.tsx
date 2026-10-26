import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: () => {
    throw new Error('the published page must not read cookies');
  },
  headers: () => {
    throw new Error('the published page must not read headers');
  },
}));

const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ notFound }));

const PAGE = {
  title: 'Quarterly plan',
  description: 'What we ship next quarter.',
  content: { type: 'doc', content: [] },
  updatedAt: '2030-01-02T03:04:05.000Z',
};

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe('published page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    notFound.mockClear();
    vi.stubEnv('WEB_ORIGIN', 'https://docs.example.com');
    vi.stubEnv('API_INTERNAL_URL', 'http://api:4000');
  });

  it('describes the page for search engines and link previews', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(PAGE)));
    const { generateMetadata } = await import('./page');
    const metadata = await generateMetadata(params('plan-3fa9c1'));
    expect(metadata.title).toBe('Quarterly plan');
    expect(metadata.description).toBe('What we ship next quarter.');
    expect(metadata.alternates?.canonical).toBe('https://docs.example.com/p/plan-3fa9c1');
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.openGraph).toMatchObject({
      type: 'article',
      title: 'Quarterly plan',
      description: 'What we ship next quarter.',
      url: 'https://docs.example.com/p/plan-3fa9c1',
      modifiedTime: PAGE.updatedAt,
    });
  });

  it('asks the api for the page with the cache tag of its slug and the ISR window', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(PAGE)));
    const { generateMetadata } = await import('./page');
    await generateMetadata(params('plan-3fa9c1'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { next?: unknown }];
    expect(url).toBe('http://api:4000/api/public/documents/plan-3fa9c1');
    expect(init.next).toEqual({ revalidate: 3600, tags: ['pub:plan-3fa9c1'] });
  });

  it('keeps an unavailable page out of the index and answers not-found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Page not found' }), {
        status: 404,
      }),
    );
    const { generateMetadata, default: Page } = await import('./page');
    expect((await generateMetadata(params('gone-3fa9c1'))).robots).toEqual({ index: false });
    await expect(Page(params('gone-3fa9c1'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('does not call the api for a slug that cannot exist', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { default: Page } = await import('./page');
    await expect(Page(params('Not A Slug'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is incrementally regenerated, with the window the data fetch uses', async () => {
    const { PUBLISHED_PAGE_REVALIDATE_SECONDS } = await import('@/lib/public/published');
    const source = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(source).toContain(`export const revalidate = ${PUBLISHED_PAGE_REVALIDATE_SECONDS};`);
    expect(source).toContain('export const generateStaticParams = () => [];');
    expect(source).not.toMatch(/['"]use client['"]|cookies\(|headers\(|dynamic\s*=/);
  });
});
