'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Confirmation before a document and everything under it goes to the trash. */
export function DeleteDocumentDialog({
  title,
  subpages,
  open,
  pending,
  onOpenChange,
  onConfirm,
  returnFocusTo,
}: {
  title: string;
  subpages: number;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** Where focus goes when the dialog closes; without it nothing has focus, as the dialog has no trigger of its own. */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (!returnFocusTo?.current) return;
          event.preventDefault();
          returnFocusTo.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Move “{title || 'Untitled'}” to trash?</DialogTitle>
          <DialogDescription>
            {subpages > 0
              ? `It and its ${subpages} subpage${subpages === 1 ? '' : 's'} leave the workspace. `
              : ''}
            You can restore it from the trash.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? 'Moving…' : 'Move to trash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
