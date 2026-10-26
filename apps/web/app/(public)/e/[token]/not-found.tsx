import Link from 'next/link';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';

export default function EditLinkNotFound() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <EmptyState
        title="This link does not work"
        description="It may have been replaced by a newer link, or the address is incomplete."
      >
        <Button asChild variant="outline">
          <Link href="/">Go to Collab Docs</Link>
        </Button>
      </EmptyState>
    </main>
  );
}
