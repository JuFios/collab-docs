'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormError } from '@/components/ui/form';
import { cancelSubscriptionAction } from '@/lib/billing/actions';
import { useActionRunner } from './use-action-runner';

/** Confirmation, then a cancellation request; the plan drops to Free once the provider's webhook is applied. */
export function CancelSubscriptionButton({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const { state, pending, execute } = useActionRunner(cancelSubscriptionAction);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Cancel subscription
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel the subscription?</DialogTitle>
            <DialogDescription>
              The workspace goes back to the Free plan. Nothing is deleted, but if it holds more
              than the Free plan allows, creating more is blocked until usage drops below the
              limits.
            </DialogDescription>
          </DialogHeader>
          <FormError message={state.formError} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Keep the plan
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => execute({ workspaceId })}
            >
              {pending ? 'Canceling…' : 'Cancel subscription'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
