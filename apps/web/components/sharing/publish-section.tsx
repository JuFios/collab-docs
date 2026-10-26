'use client';

import type { PublicLink } from '@collab-docs/shared';
import { useState } from 'react';
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

/** Why publishing has to wait, or null when it can go ahead. */
export type PublishBlock = string | null;

/**
 * "Publish to web": the page at `/p/<slug>`. Publishing reads the document as the server stored it, so it waits
 * until everything typed here has been acknowledged (otherwise the page would silently miss the last words).
 */
export function PublishSection({
  documentId,
  link,
  block,
  origin,
}: {
  documentId: string;
  link: PublicLink | undefined;
  block: PublishBlock;
  origin: string;
}) {
  const create = useCreatePublicLink(documentId);
  const update = useUpdatePublicLink(documentId);
  const revoke = useRevokePublicLink(documentId);
  const live = link?.status === 'active' ? link : undefined;
  const [expiry, setExpiry] = useState('');
  const pending = create.isPending || update.isPending || revoke.isPending;

  const publish = () =>
    create.mutate(
      { mode: 'VIEW', expiresAt: toExpiresAt(expiry) },
      {
        onSuccess: (created) => {
          if (created.flushed === false) {
            toast.warning(
              'Published, but the very latest changes may take a few seconds to appear on the page.',
            );
          }
        },
      },
    );

  return (
    <section aria-labelledby="share-publish" className="grid gap-3">
      <h3 id="share-publish" className="text-sm font-medium">
        Publish to web
      </h3>
      {live?.slug ? (
        <>
          <p className="text-sm text-muted-foreground">
            Anyone with the link can read this page. {formatExpiry(live.expiresAt)}.
          </p>
          <CopyField label="Public link" value={`${origin}/p/${live.slug}`} />
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="publish-expiry">Expires</Label>
              <Input
                id="publish-expiry"
                type="datetime-local"
                defaultValue={toLocalInput(live.expiresAt)}
                key={live.expiresAt ?? 'never'}
                onChange={(event) => setExpiry(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => update.mutate({ linkId: live.id, expiresAt: toExpiresAt(expiry) })}
            >
              Update expiry
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => revoke.mutate(live.id)}
            >
              Unpublish
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {link
              ? 'The page is not published. Publishing again restores the same address.'
              : 'Make a read-only copy of this page available to anyone with the link.'}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="publish-expiry">Expires (optional)</Label>
              <Input
                id="publish-expiry"
                type="datetime-local"
                onChange={(event) => setExpiry(event.target.value)}
              />
            </div>
            <Button type="button" disabled={pending || block !== null} onClick={publish}>
              Publish to web
            </Button>
          </div>
          {block ? (
            <p role="status" className="text-sm text-muted-foreground">
              {block}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
