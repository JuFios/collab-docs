'use client';

import { type DocumentVersion, VERSION_LABEL_MAX_LENGTH } from '@collab-docs/shared';
import { History, X } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ContentRenderer, collectImageIds } from '@/components/content/content-renderer';
import { LoadingState } from '@/components/states';
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
import { useAttachmentUrls } from '@/lib/attachments/use-attachment-urls';
import {
  useCreateVersion,
  useRestoreVersion,
  useVersionContent,
  useVersions,
} from '@/lib/versions/queries';
import { cn } from '@/lib/utils';

const KIND_LABELS: Record<DocumentVersion['kind'], string> = {
  AUTO: 'Automatic',
  MANUAL: 'Saved',
  PRE_RESTORE: 'Before restore',
};

const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function describe(version: DocumentVersion): string {
  return version.label ? `${version.label}` : KIND_LABELS[version.kind];
}

/**
 * Version history beside the editor: automatic and saved snapshots, a read-only preview of the selected one and,
 * for editors, "Save version" and "Restore". A restore is applied by the collab service as an ordinary edit, so
 * the open editor (and everyone else's) updates through the CRDT without a reload.
 */
export function VersionsPanel({
  documentId,
  canEdit,
  onClose,
}: {
  documentId: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const versions = useVersions(documentId, true);
  const create = useCreateVersion(documentId);
  const restore = useRestoreVersion(documentId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [confirming, setConfirming] = useState(false);
  const preview = useVersionContent(documentId, selectedId);
  const imageIds = useMemo(() => collectImageIds(preview.data?.content), [preview.data]);
  const imageUrls = useAttachmentUrls(imageIds);
  const selected = versions.data?.find((version) => version.id === selectedId);

  function save(event: FormEvent) {
    event.preventDefault();
    create.mutate(label.trim() || undefined, {
      onSuccess: (version) => {
        setLabel('');
        setSelectedId(version.id);
        toast.success(
          version.flushed ? 'Version saved' : 'Version saved without the last few seconds',
        );
      },
    });
  }

  return (
    <aside
      aria-label="Version history"
      data-testid="versions-panel"
      className="grid content-start gap-3 rounded-lg border bg-card p-3 text-sm"
    >
      <div className="flex items-center gap-2">
        <History className="h-4 w-4" aria-hidden />
        <h3 className="font-semibold">Version history</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close version history"
          className="ml-auto h-7 w-7"
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {canEdit ? (
        <form onSubmit={save} className="flex gap-2">
          <Input
            value={label}
            maxLength={VERSION_LABEL_MAX_LENGTH}
            placeholder="Name (optional)"
            aria-label="Version name"
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Save version'}
          </Button>
        </form>
      ) : null}

      {versions.isPending ? <LoadingState label="Loading versions…" /> : null}
      {versions.isError ? (
        <p role="alert" className="text-destructive">
          Could not load the version history.
        </p>
      ) : null}
      {versions.data?.length === 0 ? (
        <p className="text-muted-foreground">
          No versions yet. Snapshots are taken automatically while the document is edited.
        </p>
      ) : null}
      <ul className="grid max-h-56 gap-1 overflow-y-auto">
        {versions.data?.map((version) => (
          <li key={version.id}>
            <button
              type="button"
              aria-pressed={version.id === selectedId}
              onClick={() => setSelectedId(version.id)}
              className={cn(
                'grid w-full gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent',
                version.id === selectedId && 'bg-accent',
              )}
            >
              <span className="font-medium">{describe(version)}</span>
              <span className="text-xs text-muted-foreground">
                {formatter.format(new Date(version.createdAt))}
                {version.author ? ` · ${version.author.name}` : ''}
                {version.label ? ` · ${KIND_LABELS[version.kind]}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selectedId ? (
        <section aria-label="Version preview" className="grid gap-2 border-t pt-3">
          {preview.isPending ? <LoadingState label="Loading preview…" /> : null}
          {preview.isError ? (
            <p role="alert" className="text-destructive">
              Could not load this version.
            </p>
          ) : null}
          {preview.data ? (
            <>
              <h4 className="truncate font-semibold">{preview.data.title || 'Untitled'}</h4>
              <ContentRenderer
                content={preview.data.content}
                resolveImageSrc={(id) => imageUrls.get(id)}
                className="max-h-80 overflow-y-auto rounded-md border bg-background p-3 text-sm [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
              />
              {canEdit ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirming(true)}
                >
                  Restore this version
                </Button>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this version?</DialogTitle>
            <DialogDescription>
              The document returns to “{selected ? describe(selected) : 'this version'}”. The
              current content is saved as a version first, so nothing is lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={restore.isPending || !selectedId}
              onClick={() =>
                selectedId &&
                restore.mutate(selectedId, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast.success('Version restored');
                  },
                  onError: () => setConfirming(false),
                })
              }
            >
              {restore.isPending ? 'Restoring…' : 'Restore'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
