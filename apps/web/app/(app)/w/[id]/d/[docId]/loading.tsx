import { Skeleton } from '@/components/ui/skeleton';

export default function DocumentLoading() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading document">
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
