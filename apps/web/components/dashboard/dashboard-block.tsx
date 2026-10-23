import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { BlockErrorBoundary } from './block-boundary';
import { Suspense } from 'react';

export function BlockSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="grid gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * One independent dashboard block: its own error boundary, its own Suspense boundary and skeleton. The children
 * are async Server Components, so each block streams in as soon as its own data is ready.
 */
export function DashboardBlock({
  title,
  loadingLabel,
  rows,
  className,
  action,
  children,
}: {
  title: string;
  loadingLabel: string;
  rows?: number;
  className?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`block-${slug(title)}`}
      className={`rounded-lg border bg-card p-4 ${className ?? ''}`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={`block-${slug(title)}`} className="text-sm font-semibold">
          {title}
        </h2>
        {action}
      </div>
      <BlockErrorBoundary title={title}>
        <Suspense fallback={<BlockSkeleton label={loadingLabel} rows={rows} />}>
          {children}
        </Suspense>
      </BlockErrorBoundary>
    </section>
  );
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
