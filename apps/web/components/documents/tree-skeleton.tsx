import { Skeleton } from '@/components/ui/skeleton';

const WIDTHS = ['w-4/5', 'w-3/5', 'w-2/3', 'w-3/4', 'w-1/2', 'w-3/5'];

/** Same row height as the tree, so the sidebar does not change size when the data arrives. */
export function TreeSkeleton() {
  return (
    <div className="grid gap-1" aria-busy="true" aria-label="Loading documents">
      {WIDTHS.map((width, index) => (
        <div key={index} className="flex h-8 items-center px-2">
          <Skeleton className={`h-4 ${width}`} />
        </div>
      ))}
    </div>
  );
}
