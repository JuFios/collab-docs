'use client';

import type { PublicLink } from '@collab-docs/shared';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useCreatePublicLink,
  useRevokePublicLink,
  useUpdatePublicLink,
} from '@/lib/sharing/queries';
import { CopyField } from './copy-field';
import { formatExpiry, toExpiresAt, toLocalInput } from './expiry';

/**
 * "Edit link": anyone with the address edits the document as a guest. The secret is part of the address and is
 * returned once, when the link is created, so it is kept here until the dialog closes. "Regenerate" issues a new
 * address and ends the sessions that used the old one.
 */
export function EditLinkSection({
  documentId,
  link,
  origin,
}: {
  documentId: string;
  link: PublicLink | undefined;
  origin: string;
}) {
  const create = useCreatePublicLink(documentId);
  const update = useUpdatePublicLink(documentId);
  const revoke = useRevokePublicLink(documentId);
  const live = link?.status === 'active' ? link : undefined;
  const [issued, setIssued] = useState<{ linkId: string; token: string } | null>(null);
  // read when a button is pressed: the field shows the stored expiry, and an untouched field must keep it
  const expiryField = useRef<HTMLInputElement>(null);
  const chosenExpiry = () => toExpiresAt(expiryField.current?.value ?? '');
  const pending = create.isPending || update.isPending || revoke.isPending;

  const issue = () =>
    create.mutate(
      { mode: 'EDIT', expiresAt: chosenExpiry() },
      {
        onSuccess: (created) => {
          if (created.token) setIssued({ linkId: created.id, token: created.token });
        },
      },
    );
  const shown = live && issued?.linkId === live.id ? issued.token : null;

  return (
    <section aria-labelledby="share-edit-link" className="grid gap-3">
      <h3 id="share-edit-link" className="text-sm font-medium">
        Edit link
      </h3>
      {live ? (
        <>
          <p className="text-sm text-muted-foreground">
            Anyone with the link can edit this document without an account.{' '}
            {formatExpiry(live.expiresAt)}.
          </p>
          {shown ? (
            <CopyField label="Edit link" value={`${origin}/edit-link/${shown}`} />
          ) : (
            <p className="text-sm text-muted-foreground">
              The address is shown only when the link is created. Regenerate it to get a new one.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="edit-link-expiry">Expires</Label>
              <Input
                id="edit-link-expiry"
                type="datetime-local"
                defaultValue={toLocalInput(live.expiresAt)}
                key={live.expiresAt ?? 'never'}
                ref={expiryField}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                update.mutate(
                  { linkId: live.id, expiresAt: chosenExpiry() },
                  { onSuccess: () => toast.success('Expiry updated') },
                )
              }
            >
              Update expiry
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={issue}>
              Regenerate link
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setIssued(null);
                revoke.mutate(live.id);
              }}
            >
              Turn off
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Let people edit this document through a link, without signing in.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="edit-link-expiry">Expires (optional)</Label>
              <Input id="edit-link-expiry" type="datetime-local" ref={expiryField} />
            </div>
            <Button type="button" disabled={pending} onClick={issue}>
              Create edit link
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
