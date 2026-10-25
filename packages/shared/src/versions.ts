import { z } from 'zod';

export const VERSION_KINDS = ['AUTO', 'MANUAL', 'PRE_RESTORE'] as const;
export const VERSION_LABEL_MAX_LENGTH = 120;

export const documentVersionSchema = z.object({
  id: z.string(),
  kind: z.enum(VERSION_KINDS),
  label: z.string().nullable(),
  /** The document title when the snapshot was taken. */
  title: z.string(),
  /** Null for automatic snapshots. */
  author: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: z.string(),
});
export type DocumentVersion = z.infer<typeof documentVersionSchema>;

export const documentVersionListSchema = z.array(documentVersionSchema);

/** A version with its content as sanitised ProseMirror JSON, for previewing. */
export const documentVersionContentSchema = documentVersionSchema.extend({
  content: z.object({ type: z.literal('doc'), content: z.array(z.unknown()) }),
});
export type DocumentVersionContent = z.infer<typeof documentVersionContentSchema>;

export const createVersionInputSchema = z.object({
  label: z.string().trim().max(VERSION_LABEL_MAX_LENGTH).optional(),
});
export type CreateVersionInput = z.infer<typeof createVersionInputSchema>;

export const createdVersionSchema = documentVersionSchema.extend({
  /** False when the collab service could not be asked to write its buffer first; the snapshot may miss the last few seconds. */
  flushed: z.boolean(),
});
export type CreatedVersion = z.infer<typeof createdVersionSchema>;

export const restoredVersionSchema = z.object({ revision: z.number().int() });
export type RestoredVersion = z.infer<typeof restoredVersionSchema>;
