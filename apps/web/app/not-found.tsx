import Link from 'next/link';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main>
      <EmptyState
        headingLevel={1}
        title="Page not found"
        description="The page does not exist, or you do not have access to it."
      >
        <Button asChild variant="outline">
          <Link href="/">Go home</Link>
        </Button>
      </EmptyState>
    </main>
  );
}
