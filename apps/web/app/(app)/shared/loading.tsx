import { Skeleton } from '@/components/ui/skeleton';

export default function SharedLoading() {
  return (
    <div
      className="mx-auto grid max-w-3xl gap-3"
      aria-busy="true"
      aria-label="Loading shared documents"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}
