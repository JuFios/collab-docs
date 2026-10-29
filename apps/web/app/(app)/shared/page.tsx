import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';
import { Suspense } from 'react';
import { SEARCH_QUERY_MAX_LENGTH } from '@collab-docs/shared';
import { SearchKeyboardScope } from '@/components/search/search-keyboard-scope';
import { SearchResults, SearchResultsSkeleton } from '@/components/search/search-results';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSharedDocuments } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: 'Shared with me' };

type SearchParams = Promise<{ q?: string | string[]; cursor?: string | string[] }>;

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? '';

/**
 * The documents shared with the user directly, and a search through them: a guest of a document has no workspace
 * whose search it could use. The search is a plain GET form, like the workspace search.
 */
export default async function SharedPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const q = first(query.q).trim().slice(0, SEARCH_QUERY_MAX_LENGTH);
  const cursor = first(query.cursor) || undefined;
  const documents = await getSharedDocuments();
  return (
    <section aria-labelledby="shared-heading" className="mx-auto grid max-w-3xl gap-4">
      <h1 id="shared-heading" className="text-2xl font-semibold">
        Shared with me
      </h1>
      {documents.length === 0 ? (
        <EmptyState
          title="Nothing has been shared with you"
          description="Documents other people share with you directly show up here, in any workspace."
        />
      ) : (
        <>
          <SearchKeyboardScope>
            <Form action="/shared" role="search" className="flex gap-2">
              <label htmlFor="shared-search-q" className="sr-only">
                Search the documents shared with you
              </label>
              <Input
                id="shared-search-q"
                name="q"
                type="search"
                defaultValue={q}
                maxLength={SEARCH_QUERY_MAX_LENGTH}
                placeholder="Search the documents shared with you"
                autoComplete="off"
                data-search-input
              />
              <Button type="submit">Search</Button>
            </Form>
            {q ? (
              <Suspense key={`${q}\u0000${cursor ?? ''}`} fallback={<SearchResultsSkeleton />}>
                <SearchResults workspaceId={null} q={q} cursor={cursor} />
              </Suspense>
            ) : null}
          </SearchKeyboardScope>
          {q ? null : (
            <ul className="divide-y rounded-lg border bg-card">
              {documents.map((document) => (
                <li key={document.id}>
                  <Link
                    href={`/workspaces/${document.workspaceId}/documents/${document.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-accent/50"
                  >
                    <span className="truncate">
                      <span aria-hidden>{document.icon ?? '📄'}</span>{' '}
                      {document.title || 'Untitled'}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {document.role === 'EDITOR' ? 'Can edit' : 'Can view'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
