'use client';

import { type DocumentDetails, accessAtLeast } from '@collab-docs/shared';
import { Share2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { isApiError } from '@/lib/api/errors';
import { usePublicLinks } from '@/lib/sharing/queries';
import { EditLinkSection } from './edit-link-section';
import { PeopleSection } from './people-section';
import { type PublishBlock, PublishSection } from './publish-section';

/** What the editor knows about the state of its own changes; publishing needs all of them stored. */
interface DocumentSyncState {
  online: boolean;
  synced: boolean;
  hasUnsyncedChanges: boolean;
}

export function publishBlock({
  online,
  synced,
  hasUnsyncedChanges,
}: DocumentSyncState): PublishBlock {
  if (!online) {
    return 'You are offline. Publishing reads the saved document, so it needs a connection to store your changes first.';
  }
  if (!synced) return 'Connecting to the document…';
  if (hasUnsyncedChanges)
    return 'Saving your latest changes… Publishing is available once they are saved.';
  return null;
}

/**
 * The Share button and its dialog: who in the workspace can open the document, the read-only web page and the
 * edit link. Visible from EDIT up; the api further limits sharing to managers and to editors who authored it.
 */
export function ShareDialog({
  document,
  sync,
}: {
  document: DocumentDetails;
  sync: DocumentSyncState;
}) {
  const [open, setOpen] = useState(false);
  const allowed = accessAtLeast(document.myAccess, 'EDIT');
  const links = usePublicLinks(document.id, open && allowed);
  if (!allowed) return null;

  const forbidden = links.error && isApiError(links.error) && links.error.status === 403;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const view = links.data?.find((link) => link.mode === 'VIEW');
  const edit = links.data?.find((link) => link.mode === 'EDIT');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Share2 className="h-4 w-4" aria-hidden /> Share
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Share document</DialogTitle>
          <DialogDescription>
            Choose who can open “{document.title || 'Untitled'}”, and whether it is public.
          </DialogDescription>
        </DialogHeader>
        {forbidden ? (
          <p role="status" className="text-sm text-muted-foreground">
            Only the document&apos;s managers and its author can change how it is shared.
          </p>
        ) : (
          <div className="grid gap-6">
            <PeopleSection
              documentId={document.id}
              visibility={document.visibility}
              enabled={open}
            />
            <PublishSection
              documentId={document.id}
              link={view}
              block={publishBlock(sync)}
              origin={origin}
            />
            <EditLinkSection documentId={document.id} link={edit} origin={origin} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
