'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';

/**
 * The overview, the search results and the trash are rendered on the server, so a change made from the tree beside
 * them (a rename, a deletion) leaves them stale until something refreshes them. A document page lists nothing, and
 * the tree there is live on its own.
 */
export function useRefreshListings(): () => void {
  const router = useRouter();
  const pathname = usePathname();
  const onDocumentPage = pathname.includes('/documents/');
  return useCallback(() => {
    if (!onDocumentPage) router.refresh();
  }, [onDocumentPage, router]);
}
