'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
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
import { removeMemberAction } from '@/lib/workspaces/actions';

/**
 * Client component: confirmation dialog, and the action runs from an event handler. Leaving is the same api call as
 * removing yourself; the api refuses it for the last owner and the dialog shows that reason.
 */
export function LeaveWorkspaceButton({
  workspaceId,
  workspaceName,
  userId,
}: {
  workspaceId: string;
  workspaceName: string;
  userId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  function leave() {
    startTransition(async () => {
      const result = await removeMemberAction({ workspaceId, userId });
      if (!result.ok) {
        setError(result.formError ?? 'Could not leave the workspace.');
        return;
      }
      setOpen(false);
      toast.success(`You left ${workspaceName}.`);
      // the workspace page would 404 now; go to the list (and refresh the navbar switcher with it)
      router.push('/w?all=1');
      router.refresh();
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(undefined);
          setOpen(true);
        }}
      >
        Leave workspace
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave {workspaceName}?</DialogTitle>
            <DialogDescription>
              You lose access to this workspace and to documents shared through it. An admin can
              invite you again.
            </DialogDescription>
          </DialogHeader>
          <FormError message={error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={pending} onClick={leave}>
              {pending ? 'Leaving…' : 'Leave workspace'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
