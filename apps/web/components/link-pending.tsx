'use client';

import { Loader2 } from 'lucide-react';
import { useLinkStatus } from 'next/link';

/**
 * Shown inside a `<Link>` while the page it leads to is loading. Pages that are not streamed (their forms work
 * without JavaScript, so they have no `loading.tsx`) show their wait this way.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span role="status" className="ml-1.5 inline-flex align-middle">
      <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
      <span className="sr-only">Loading…</span>
    </span>
  );
}
