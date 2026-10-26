import { Prisma } from '@collab-docs/db';

/**
 * The one definition of a document that is not in the trash. Trash and restore deliberately address deleted
 * rows directly, so they do not use it.
 */
export const LIVE_DOCUMENT = { deletedAt: null } as const satisfies Prisma.DocumentWhereInput;

/** `LIVE_DOCUMENT` for raw queries over `documents` (the column must not be ambiguous in the query). */
export const LIVE_DOCUMENT_SQL = Prisma.sql`deleted_at IS NULL`;
