'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import {
  type ComponentProps,
  type HTMLAttributes,
  type RefObject,
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react';
import { cn } from '@/lib/utils';

const OpenerContext = createContext<RefObject<HTMLElement | null> | null>(null);

/**
 * Radix returns focus to the `DialogTrigger` when a dialog closes. A dialog that is opened by some other button
 * (most of them here: they are controlled by state) has no trigger, so focus fell to the page and a keyboard user
 * lost their place. A controlled dialog remembers what had focus when it opened and gives it back.
 */
export function Dialog({ open, ...props }: ComponentProps<typeof DialogPrimitive.Root>) {
  const opener = useRef<HTMLElement | null>(null);
  // before the dialog's own focus handling runs, which is in a passive effect further down
  useLayoutEffect(() => {
    if (open)
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  return (
    <OpenerContext value={opener}>
      <DialogPrimitive.Root open={open} {...props} />
    </OpenerContext>
  );
}
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({
  className,
  children,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  const opener = useContext(OpenerContext);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-6 shadow-lg',
          className,
        )}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const element = opener?.current;
          // an opener that is gone (its row was deleted, say) leaves focus to the library
          if (event.defaultPrevented || !element?.isConnected) return;
          event.preventDefault();
          element.focus();
        }}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X className="h-4 w-4" aria-hidden />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-lg font-semibold leading-none', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}
