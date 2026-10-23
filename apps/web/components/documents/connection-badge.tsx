'use client';

import { useWorkspace } from '@/components/workspaces/workspace-provider';
import { cn } from '@/lib/utils';

const LABELS = {
  open: 'Live',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
} as const;

/** State of the realtime stream, so a stale tree is never a mystery. */
export function ConnectionBadge() {
  const { connection } = useWorkspace();
  return (
    <span
      role="status"
      aria-live="polite"
      data-state={connection}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span
        aria-hidden
        className={cn(
          'h-2 w-2 rounded-full',
          connection === 'open' && 'bg-emerald-500',
          (connection === 'connecting' || connection === 'reconnecting') &&
            'animate-pulse bg-amber-500',
          connection === 'offline' && 'bg-destructive',
        )}
      />
      {LABELS[connection]}
    </span>
  );
}
