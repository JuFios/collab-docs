'use client';

import { type SaveStatus, SAVE_STATUS_LABELS } from '@/lib/collab/save-status';
import { cn } from '@/lib/utils';

/** One status line for the whole document: the title (REST) and the content (CRDT) report into it. */
export function SaveIndicator({ status }: { status: SaveStatus }) {
  return (
    <span
      role="status"
      aria-live="polite"
      data-state={status}
      data-testid="save-status"
      className={cn(
        'shrink-0 text-xs text-muted-foreground',
        status === 'offline' && 'text-amber-600 dark:text-amber-400',
        status === 'error' && 'text-destructive',
      )}
    >
      {SAVE_STATUS_LABELS[status]}
    </span>
  );
}
