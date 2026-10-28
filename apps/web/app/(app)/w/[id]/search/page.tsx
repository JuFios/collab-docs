import type { Metadata } from 'next';
import Form from 'next/form';
import { Suspense } from 'react';
import { SEARCH_QUERY_MAX_LENGTH } from '@collab-docs/shared';
import { SearchKeyboardScope } from '@/components/search/search-keyboard-scope';
import { SearchResults, SearchResultsSkeleton } from '@/components/search/search-results';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { requireWorkspace } from '@/lib/workspaces/data';

type SearchParams = Promise<{ q?: string | string[]; cursor?: string | string[] }>;

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? '';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const q = first((await searchParams).q)
    .trim()
    .slice(0, 60);
  return { title: q ? `${q} · Search` : 'Search' };
}

/**
 * A plain GET form (`next/form`: client navigation when scripts run, an ordinary request when they do not) and a
 * Server Component that asks the api. The query lives in the URL, so a search can be shared and reloaded; the
 * results stream in behind the form.
 */
export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  await requireWorkspace(id);
  const query = await searchParams;
  const q = first(query.q).trim().slice(0, SEARCH_QUERY_MAX_LENGTH);
  const cursor = first(query.cursor) || undefined;

  return (
    <section aria-labelledby="search-heading" className="grid gap-4">
      <h2 id="search-heading" className="text-lg font-semibold">
        Search
      </h2>
      <SearchKeyboardScope>
        <Form action={`/w/${id}/search`} role="search" className="flex gap-2">
          <label htmlFor="search-q" className="sr-only">
            Search documents
          </label>
          <Input
            id="search-q"
            name="q"
            type="search"
            defaultValue={q}
            maxLength={SEARCH_QUERY_MAX_LENGTH}
            placeholder="Search titles and text"
            autoComplete="off"
            autoFocus={!q}
            data-search-input
          />
          <Button type="submit">Search</Button>
        </Form>
        {q ? (
          <Suspense key={`${q}\u0000${cursor ?? ''}`} fallback={<SearchResultsSkeleton />}>
            <SearchResults workspaceId={id} q={q} cursor={cursor} />
          </Suspense>
        ) : (
          <EmptyState
            title="Search this workspace"
            description="Type the words you remember from a title or the text. You only see documents you have access to."
          />
        )}
      </SearchKeyboardScope>
    </section>
  );
}
