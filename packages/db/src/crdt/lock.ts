import type { Prisma } from '../generated/client';

/**
 * Appending to the update log takes the document's advisory lock in shared mode, compaction takes it exclusively.
 * Without it a compaction could read the log while an append with a lower `id` is still uncommitted, fold only the
 * higher ids into the state and delete them, and the late row would then fall below `last_update_id` and never
 * be loaded again.
 */
export async function lockDocumentShared(tx: Prisma.TransactionClient, documentId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${documentId}::text, 0))`;
}

export async function lockDocumentExclusive(tx: Prisma.TransactionClient, documentId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${documentId}::text, 0))`;
}
