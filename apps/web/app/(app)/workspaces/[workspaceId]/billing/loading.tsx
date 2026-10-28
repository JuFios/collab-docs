import { Skeleton } from '@/components/ui/skeleton';

export default function BillingLoading() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Loading billing">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
