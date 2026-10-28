// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchPage } from '@collab-docs/shared';

const data = vi.hoisted(() => ({ searchDocuments: vi.fn() }));
vi.mock('@/lib/workspaces/data', () => data);

import { ApiError } from '@/lib/api/errors';
import { SearchResultList, SearchResults } from './search-results';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const WORKSPACE = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const DOCUMENT = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';

const page = (overrides: Partial<SearchPage> = {}): SearchPage => ({
  items: [
    {
      id: DOCUMENT,
      title: 'Quarterly plan',
      snippet: [
        { text: 'the ', match: false },
        { text: 'plan', match: true },
        { text: ' for Q4', match: false },
      ],
      updatedAt: '2020-01-01T00:00:00.000Z',
    },
  ],
  nextCursor: null,
  ...overrides,
});

describe('SearchResultList', () => {
  it('links each result to its document and marks the matches', () => {
    render(<SearchResultList workspaceId={WORKSPACE} q="plan" isFirstPage page={page()} />);
    const link = screen.getByRole('link', { name: /Quarterly plan/ });
    expect(link).toHaveAttribute('href', `/workspaces/${WORKSPACE}/documents/${DOCUMENT}`);
    expect(link).toHaveAttribute('data-search-result');
    const marks = within(link).getAllByText('plan', { selector: 'mark' });
    expect(marks).toHaveLength(1);
  });

  it('shows markup in a title or snippet as text', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = render(
      <SearchResultList
        workspaceId={WORKSPACE}
        q="x"
        isFirstPage
        page={page({
          items: [
            {
              id: DOCUMENT,
              title: hostile,
              snippet: [{ text: hostile, match: true }],
              updatedAt: '2020-01-01T00:00:00.000Z',
            },
          ],
        })}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText(hostile).length).toBeGreaterThan(0);
  });

  it('names an untitled document', () => {
    render(
      <SearchResultList
        workspaceId={WORKSPACE}
        q="x"
        isFirstPage
        page={page({ items: [{ ...page().items[0]!, title: '' }] })}
      />,
    );
    expect(screen.getByText('Untitled')).toBeInTheDocument();
  });

  it('links to the next page and back to the first, keeping the query', () => {
    render(
      <SearchResultList
        workspaceId={WORKSPACE}
        q="plan & more"
        isFirstPage={false}
        page={page({ nextCursor: 'abc_-1' })}
      />,
    );
    expect(screen.getByRole('link', { name: 'More results' })).toHaveAttribute(
      'href',
      `/workspaces/${WORKSPACE}/search?q=plan+%26+more&cursor=abc_-1`,
    );
    expect(screen.getByRole('link', { name: 'First results' })).toHaveAttribute(
      'href',
      `/workspaces/${WORKSPACE}/search?q=plan+%26+more`,
    );
  });

  it('says so when nothing matches', () => {
    render(
      <SearchResultList workspaceId={WORKSPACE} q="zzz" isFirstPage page={page({ items: [] })} />,
    );
    expect(screen.getByText('No documents match “zzz”')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('SearchResults', () => {
  it('asks the api for the query and the cursor', async () => {
    data.searchDocuments.mockResolvedValue(page());
    render(await SearchResults({ workspaceId: WORKSPACE, q: 'plan', cursor: 'next' }));
    expect(data.searchDocuments).toHaveBeenCalledWith(WORKSPACE, 'plan', 'next');
    expect(screen.getByRole('list', { name: 'Search results' })).toBeInTheDocument();
  });

  it.each([
    [429, /too fast/],
    [400, /not valid/],
    [500, /Something went wrong/],
  ])('shows a %s in place of the results', async (status, text) => {
    data.searchDocuments.mockRejectedValue(
      new ApiError(status, 'INTERNAL_ERROR', 'failed', 'corr-1'),
    );
    render(await SearchResults({ workspaceId: WORKSPACE, q: 'plan' }));
    expect(screen.getByText('The search failed')).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-1')).toBeInTheDocument();
  });

  it('does not swallow errors that are not api errors', async () => {
    data.searchDocuments.mockRejectedValue(new TypeError('boom'));
    await expect(SearchResults({ workspaceId: WORKSPACE, q: 'plan' })).rejects.toThrow('boom');
  });
});
