import { z } from 'zod';

export const DOCUMENT_TITLE_MAX_LENGTH = 200;
export const DEFAULT_DOCUMENT_TITLE = 'Untitled';

const visibilitySchema = z.enum(['WORKSPACE', 'RESTRICTED']);
/** What the caller may do with a document; `NONE` never reaches a client (the api answers 404). */
const myAccessSchema = z.enum(['VIEW', 'COMMENT', 'EDIT', 'MANAGE']);

/** One node of the flat tree. `parentId` is null at the root and under a parent the caller cannot see. */
export const treeNodeSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  title: z.string(),
  icon: z.string().nullable(),
  position: z.string(),
  visibility: visibilitySchema,
  myAccess: myAccessSchema,
});
export const treeNodeListSchema = z.array(treeNodeSchema);

export const documentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  title: z.string(),
  icon: z.string().nullable(),
  position: z.string(),
  visibility: visibilitySchema,
  createdBy: z.string().uuid(),
  revision: z.number().int(),
  myAccess: myAccessSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const movedDocumentSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  position: z.string(),
});

export const trashItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  icon: z.string().nullable(),
  deletedAt: z.string(),
  documentCount: z.number().int(),
  canRestore: z.boolean(),
});
export const trashItemListSchema = z.array(trashItemSchema);

/** Same rule as the api DTO: trimmed, at most 200 characters (an empty title is shown as "Untitled"). */
export const documentTitleSchema = z.string().trim().max(DOCUMENT_TITLE_MAX_LENGTH);

export const createDocumentInputSchema = z.object({
  parentId: z.string().uuid().optional(),
  title: documentTitleSchema,
});

export const moveDocumentInputSchema = z.object({
  parentId: z.string().uuid().nullable(),
  beforeId: z.string().uuid().optional(),
  afterId: z.string().uuid().optional(),
});

export type TreeNode = z.infer<typeof treeNodeSchema>;
export type DocumentDetails = z.infer<typeof documentSchema>;
export type MovedDocument = z.infer<typeof movedDocumentSchema>;
export type TrashItem = z.infer<typeof trashItemSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>;
export type MoveDocumentInput = z.infer<typeof moveDocumentInputSchema>;
