'use client';

import { useMutation } from '@tanstack/react-query';
import type { Editor } from '@tiptap/core';
import { useCallback, useState } from 'react';
import { uploadAttachment } from '@/lib/attachments/upload';

interface UploadProgress {
  id: string;
  name: string;
  /** 0..1 */
  progress: number;
}

/**
 * Uploads image files and inserts an `image` block for each one that the server accepted. Failures (type, size,
 * quota) go through the shared mutation error handler, which shows the toast or the plan-limit dialog.
 */
export function useImageUpload(documentId: string, editor: Editor | null) {
  const [uploads, setUploads] = useState<UploadProgress[]>([]);

  const mutation = useMutation({
    mutationFn: async ({ file, position }: { file: File; position?: number }) => {
      const id = crypto.randomUUID();
      setUploads((current) => [...current, { id, name: file.name, progress: 0 }]);
      try {
        const attachmentId = await uploadAttachment(documentId, file, (progress) =>
          setUploads((current) =>
            current.map((upload) => (upload.id === id ? { ...upload, progress } : upload)),
          ),
        );
        return { attachmentId, alt: file.name, position };
      } finally {
        setUploads((current) => current.filter((upload) => upload.id !== id));
      }
    },
    onSuccess: ({ attachmentId, alt, position }) => {
      if (!editor || editor.isDestroyed || !editor.isEditable) return;
      const chain = editor.chain().focus();
      if (position !== undefined) chain.setTextSelection(position);
      chain.insertContent({ type: 'image', attrs: { attachmentId, alt } }).run();
    },
  });

  const { mutate } = mutation;
  const upload = useCallback(
    (files: readonly File[], position?: number) => {
      for (const file of files) mutate({ file, position });
    },
    [mutate],
  );

  return { upload, uploads };
}
