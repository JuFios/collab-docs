import { z } from 'zod';

/** Raster image types a document may embed; SVG and everything else is refused at every layer (P7). */
export const ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number];

export const ATTACHMENT_EXTENSIONS: Record<AttachmentMime, readonly string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
};

export const ATTACHMENT_FILENAME_MAX_LENGTH = 255;
export const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** How long an upload policy and a read URL stay valid. */
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 10 * 60;
export const ATTACHMENT_READ_TTL_SECONDS = 5 * 60;

export const isAttachmentMime = (value: unknown): value is AttachmentMime =>
  typeof value === 'string' && (ATTACHMENT_MIME_TYPES as readonly string[]).includes(value);

/** Lower-cased extension of a file name, or `null` when it has none. */
export function fileExtension(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

/** True when the file name ends in an extension that belongs to `mime`. */
export const filenameMatchesMime = (filename: string, mime: AttachmentMime): boolean => {
  const extension = fileExtension(filename);
  return extension !== null && ATTACHMENT_EXTENSIONS[mime].includes(extension);
};

/** Number of leading bytes `sniffImageType` needs. */
export const SNIFF_BYTES = 12;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/** Identifies an allowed image type from its magic number; `null` for anything else (including SVG and text). */
export function sniffImageType(bytes: Uint8Array): AttachmentMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

export const presignAttachmentInputSchema = z.object({
  filename: z.string().trim().min(1).max(ATTACHMENT_FILENAME_MAX_LENGTH),
  mime: z.enum(ATTACHMENT_MIME_TYPES),
  size: z.number().int().positive(),
});
export type PresignAttachmentInput = z.infer<typeof presignAttachmentInputSchema>;

/** Browser upload: `POST url` as multipart/form-data with `fields` first and the file last. */
export const presignedAttachmentSchema = z.object({
  attachmentId: z.string(),
  url: z.string(),
  fields: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});
export type PresignedAttachment = z.infer<typeof presignedAttachmentSchema>;

export const attachmentSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  mime: z.enum(ATTACHMENT_MIME_TYPES),
  size: z.number().int(),
  status: z.enum(['PENDING', 'READY']),
  createdAt: z.string(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const attachmentUrlSchema = z.object({ url: z.string(), expiresAt: z.string() });
export type AttachmentUrl = z.infer<typeof attachmentUrlSchema>;
