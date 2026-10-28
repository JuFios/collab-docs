import { Skeleton } from '@/components/ui/skeleton';

export default function TrashLoading() {
  return (
    <div className="grid gap-3" aria-busy="true" aria-label="Loading trash">
      <Skeleton className="h-6 w-24" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
