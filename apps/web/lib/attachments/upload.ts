import {
  type AttachmentMime,
  attachmentSchema,
  filenameMatchesMime,
  isAttachmentMime,
  presignedAttachmentSchema,
} from '@collab-docs/shared';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';

export const IMAGE_TYPES_LABEL = 'PNG, JPEG, WebP or GIF';

/** Checks a file before any request; the server and the bucket enforce the same rules again. */
export function validateImageFile(file: File): AttachmentMime {
  if (!isAttachmentMime(file.type) || !filenameMatchesMime(file.name, file.type)) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Only ${IMAGE_TYPES_LABEL} images can be added.`);
  }
  if (file.size <= 0) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The file is empty.');
  }
  return file.type;
}

function postToStorage(
  url: string,
  fields: Record<string, string>,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    // the policy fields have to come first; the file is the last part
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append('file', file);
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        reject(
          new ApiError(
            request.status === 413 ? 413 : 400,
            request.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED',
            'The file storage rejected the upload.',
          ),
        );
      }
    };
    request.onerror = () =>
      reject(new ApiError(503, 'NETWORK_ERROR', 'Cannot reach the file storage'));
    request.send(form);
  });
}

/**
 * presign -> upload to the bucket -> complete. Resolves with the attachment id once the server has verified the
 * stored object, which is what the document's image node points at.
 */
export async function uploadAttachment(
  documentId: string,
  file: File,
  onProgress: (fraction: number) => void = () => undefined,
): Promise<string> {
  const mime = validateImageFile(file);
  const presigned = await apiClient.request(`/documents/${documentId}/attachments/presign`, {
    method: 'POST',
    body: { filename: file.name, mime, size: file.size },
    schema: presignedAttachmentSchema,
  });
  await postToStorage(presigned.url, presigned.fields, file, onProgress);
  const attachment = await apiClient.request(`/attachments/${presigned.attachmentId}/complete`, {
    method: 'POST',
    schema: attachmentSchema,
  });
  return attachment.id;
}
