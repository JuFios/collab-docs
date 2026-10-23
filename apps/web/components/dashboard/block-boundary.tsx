'use client';

import { useRouter } from 'next/navigation';
import { Component, type ReactNode, useTransition } from 'react';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';

function BlockError({ title, onRetry }: { title: string; onRetry: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <ErrorState
      title={`Could not load ${title.toLowerCase()}`}
      description="The rest of the page is unaffected."
    >
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(() => {
            router.refresh();
            onRetry();
          })
        }
      >
        {pending ? 'Retrying…' : 'Try again'}
      </Button>
    </ErrorState>
  );
}

interface Props {
  title: string;
  children: ReactNode;
}

/**
 * Error boundary for one dashboard block. Error boundaries must be class components, so it is a Client Component;
 * a failing server block renders here without touching its siblings.
 */
export class BlockErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <BlockError title={this.props.title} onRetry={() => this.setState({ failed: false })} />
      );
    }
    return this.props.children;
  }
}
