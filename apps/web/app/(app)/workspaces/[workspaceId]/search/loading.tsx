import { Skeleton } from '@/components/ui/skeleton';

export default function SearchLoading() {
  return (
    <div className="grid gap-3" aria-busy="true" aria-label="Loading search">
      <Skeleton className="h-6 w-24" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}
