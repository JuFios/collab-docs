'use client';

import { ATTACHMENT_MIME_TYPES } from '@collab-docs/shared';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { Skeleton } from '@/components/ui/skeleton';
import type { BlockCommentsController } from './block-comments';
import { EditorToolbar } from './editor-toolbar';
import { createEditorExtensions } from './extensions';
import { useImageUpload } from './use-image-upload';

function imageFiles(list: DataTransfer | null): File[] {
  return [...(list?.files ?? [])].filter((file) => file.type.startsWith('image/'));
}

/**
 * The block editor bound to one `Y.Doc` / provider pair. Mount it with `key={ydoc.guid}`: when the session is
 * recreated (access downgrade, retry) the whole editor, with its ProseMirror state, is replaced rather than
 * rebound to another document.
 */
export function DocumentEditor({
  documentId,
  ydoc,
  provider,
  synced,
  editable,
  images = true,
  blockComments,
  onEditor,
}: {
  documentId: string;
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  synced: boolean;
  editable: boolean;
  /** False for guests with an edit link: the attachments api needs a signed-in user. */
  images?: boolean;
  /** Comment markers next to blocks; the page drives them through the controller. */
  blockComments?: BlockCommentsController;
  /** Hands the page the editor once its content is shown (for the comments panel); `null` before that and on teardown. */
  onEditor?: (editor: Editor | null) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const pickImageClick = useCallback(() => fileInput.current?.click(), []);
  const pickImage = images ? pickImageClick : undefined;
  const uploadRef = useRef<(files: readonly File[], position?: number) => void>(() => undefined);
  // the content is shown from the first sync on; a later disconnect keeps the editor (and the caret) in place
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (synced) setReady(true);
  }, [synced]);

  const extensions = useMemo(
    // a change of access rebuilds the editor: the extensions differ for readers (see `editable` there)
    () => createEditorExtensions({ ydoc, provider, pickImage, editable, blockComments }),
    [ydoc, provider, pickImage, editable, blockComments],
  );
  const editor = useEditor(
    {
      extensions,
      editable,
      // the page is rendered on the server first; the editor only exists in the browser
      immediatelyRender: false,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': 'Document content',
          'aria-multiline': 'true',
          class: 'collab-editor min-h-64 focus:outline-none',
        },
        handleDrop: (view, event) => {
          const files = imageFiles(event.dataTransfer);
          if (files.length === 0 || !view.editable || !images) return false;
          event.preventDefault();
          const target = view.posAtCoords({ left: event.clientX, top: event.clientY });
          uploadRef.current(files, target?.pos);
          return true;
        },
        handlePaste: (view, event) => {
          const files = imageFiles(event.clipboardData);
          // a copied table or page also carries a picture; only a bare image is an upload
          if (
            files.length === 0 ||
            !view.editable ||
            !images ||
            event.clipboardData?.getData('text/plain')
          ) {
            return false;
          }
          event.preventDefault();
          uploadRef.current(files);
          return true;
        },
      },
    },
    [extensions],
  );
  useEffect(() => {
    onEditor?.(ready ? editor : null);
    return () => onEditor?.(null);
  }, [editor, ready, onEditor]);
  const { upload, uploads } = useImageUpload(documentId, editor);
  uploadRef.current = upload;

  return (
    <div className="grid gap-3">
      {editable && editor && ready ? (
        <EditorToolbar editor={editor} onPickImage={pickImage} />
      ) : null}
      {uploads.length > 0 ? (
        <ul aria-label="Uploads" className="grid gap-1 text-sm text-muted-foreground">
          {uploads.map((item) => (
            <li key={item.id} role="status">
              Uploading {item.name} · {Math.round(item.progress * 100)}%
            </li>
          ))}
        </ul>
      ) : null}
      {ready ? null : (
        <div role="status" aria-label="Loading the document" className="grid gap-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
          <Skeleton className="h-5 w-4/6" />
        </div>
      )}
      <EditorContent editor={editor} className={ready ? undefined : 'hidden'} />
      {images ? (
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept={ATTACHMENT_MIME_TYPES.join(',')}
          aria-label="Upload an image"
          onChange={(event) => {
            upload([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
      ) : null}
    </div>
  );
}
