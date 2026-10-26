'use client';

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { ImageOff } from 'lucide-react';
import { useAttachmentUrl } from '@/lib/attachments/queries';
import { cn } from '@/lib/utils';

/** An image block: the document stores only the attachment id, the picture is read through a signed URL. */
export function ImageView({ node, selected }: NodeViewProps) {
  const attachmentId = typeof node.attrs.attachmentId === 'string' ? node.attrs.attachmentId : null;
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
  const url = useAttachmentUrl(attachmentId);

  return (
    <NodeViewWrapper
      as="figure"
      data-testid="image-block"
      className={cn('my-3 w-fit max-w-full rounded-md', selected && 'ring-2 ring-ring')}
    >
      {url.data ? (
        // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived storage URL
        <img src={url.data.url} alt={alt} className="max-h-[32rem] max-w-full rounded-md" />
      ) : (
        <div
          role={url.isError ? 'img' : 'status'}
          aria-label={url.isError ? 'Image unavailable' : 'Loading image'}
          className="flex h-32 w-64 items-center justify-center rounded-md border border-dashed bg-muted text-muted-foreground"
        >
          {url.isError ? <ImageOff className="h-6 w-6" aria-hidden /> : null}
        </div>
      )}
    </NodeViewWrapper>
  );
}
