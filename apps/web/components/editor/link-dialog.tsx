'use client';

import { LINK_PROTOCOLS } from '@collab-docs/shared/content';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Accepts a link only with a protocol the content model allows; a bare domain gets https. */
export function normalizeHref(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    return (LINK_PROTOCOLS as readonly string[]).includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function LinkDialog({
  open,
  initialHref,
  onOpenChange,
  onSubmit,
  onRemove,
  onCloseAutoFocus,
}: {
  open: boolean;
  initialHref: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (href: string) => void;
  onRemove: () => void;
  /** Where focus goes when the dialog closes; the editor, whose text the link is about. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [value, setValue] = useState(initialHref);
  const [invalid, setInvalid] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const href = normalizeHref(value);
    if (!href) {
      setInvalid(true);
      return;
    }
    onSubmit(href);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Link</DialogTitle>
            <DialogDescription>http, https and mailto links are allowed.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="link-href">Address</Label>
            <Input
              id="link-href"
              value={value}
              autoFocus
              aria-invalid={invalid}
              onChange={(event) => {
                setValue(event.target.value);
                setInvalid(false);
              }}
            />
            {invalid ? (
              <p role="alert" className="text-sm text-destructive">
                Enter a valid http, https or mailto address.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {initialHref ? (
              <Button type="button" variant="outline" onClick={onRemove}>
                Remove link
              </Button>
            ) : null}
            <Button type="submit">Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
