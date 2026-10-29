import Link from 'next/link';
import type { SearchPage } from '@collab-docs/shared';
import { EmptyState, ErrorState } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api/errors';
import { searchDocuments, searchSharedDocuments } from '@/lib/workspaces/data';
import { formatRelative } from '@/lib/workspaces/labels';
import { Snippet } from './snippet';

/** `workspaceId` null: the search of the documents shared with the user, on the "Shared with me" page. */
const searchHref = (workspaceId: string | null, q: string, cursor?: string) => {
  const params = new URLSearchParams({ q });
  if (cursor) params.set('cursor', cursor);
  const page = workspaceId === null ? '/shared' : `/workspaces/${workspaceId}/search`;
  return `${page}?${params.toString()}`;
};

export function SearchResultsSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Searching">
      {[0, 1, 2].map((row) => (
        <div key={row} className="grid gap-2">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}

/** The list itself, without data fetching: a page of results for the query `q`. */
export function SearchResultList({
  workspaceId,
  q,
  isFirstPage,
  page,
}: {
  workspaceId: string | null;
  q: string;
  isFirstPage: boolean;
  page: SearchPage;
}) {
  if (page.items.length === 0) {
    return (
      <EmptyState
        title={isFirstPage ? `No documents match “${q}”` : 'No more results'}
        description={
          isFirstPage
            ? 'Try fewer or shorter words: each word is matched as the start of a word. A document that was just edited can take a few seconds to show up.'
            : undefined
        }
      />
    );
  }
  return (
    <div className="grid gap-3">
      <ol aria-label="Search results" className="divide-y rounded-md border">
        {page.items.map((item) => (
          <li key={item.id}>
            <Link
              data-search-result
              href={`/workspaces/${item.workspaceId}/documents/${item.id}`}
              className="grid gap-1 px-4 py-3 outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="font-medium">{item.title || 'Untitled'}</span>
              {item.snippet.length > 0 ? (
                <span className="text-sm text-muted-foreground">
                  <Snippet parts={item.snippet} />
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                Updated {formatRelative(item.updatedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      <nav aria-label="Search pages" className="flex gap-4 text-sm">
        {isFirstPage ? null : (
          <Link className="underline underline-offset-4" href={searchHref(workspaceId, q)}>
            First results
          </Link>
        )}
        {page.nextCursor ? (
          <Link
            className="underline underline-offset-4"
            href={searchHref(workspaceId, q, page.nextCursor)}
          >
            More results
          </Link>
        ) : null}
      </nav>
    </div>
  );
}

/** Fetches and shows one page; a failed search is shown in place, so the search field stays usable. */
export async function SearchResults({
  workspaceId,
  q,
  cursor,
}: {
  workspaceId: string | null;
  q: string;
  cursor?: string;
}) {
  let page: SearchPage;
  try {
    page =
      workspaceId === null
        ? await searchSharedDocuments(q, cursor)
        : await searchDocuments(workspaceId, q, cursor);
  } catch (error) {
    if (!isApiError(error)) throw error;
    return (
      <ErrorState
        title="The search failed"
        description={
          error.status === 429
            ? 'You are searching too fast. Wait a moment and try again.'
            : error.status === 400
              ? 'This search is not valid. Change the words or start from the first results.'
              : 'Something went wrong while searching. Try again in a moment.'
        }
        correlationId={error.correlationId}
      />
    );
  }
  return <SearchResultList workspaceId={workspaceId} q={q} isFirstPage={!cursor} page={page} />;
}
