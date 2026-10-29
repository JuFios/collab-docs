import { randomUUID } from 'node:crypto';

/** Where an attachment is stored and served from (the `key` column). Nobody can write to it with an upload form. */
export const attachmentKey = (workspaceId: string, documentId: string): string =>
  `ws/${workspaceId}/doc/${documentId}/${randomUUID()}`;

/**
 * Where the browser uploads it. The presigned form stays valid until it expires, so `complete` copies the file to
 * `key` and checks the copy; whatever is posted later stays here, and the bucket expires this prefix after a day.
 */
export const uploadKeyOf = (key: string): string => `uploads/${key}`;
