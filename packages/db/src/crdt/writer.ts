import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type { PrismaClient } from '../generated/client';
import { lockDocumentExclusive, lockDocumentShared } from './lock';

export interface AppendResult {
  /** `false` when the same bytes were stored before (a retried flush whose first attempt did commit). */
  inserted: boolean;
  /** `documents.revision` after this write. */
  revision: number;
}

export interface CompactionResult {
  /** Log rows folded into the state and deleted. */
  folded: number;
  /** Rows that could not be decoded; they are deleted with the others (nothing can ever read them). */
  skipped: number;
}

export const hashUpdate = (update: Uint8Array): string =>
  createHash('sha256').update(update).digest('hex');

/** Writes document content: appends to the update log and compacts it. */
export class DocumentStateWriter {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Stores one (merged) update and, in the same transaction, bumps `revision` and `content_updated_at`, so a
   * consumer that sees the new revision is guaranteed to find the content.
   */
  async append(documentId: string, update: Uint8Array): Promise<AppendResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockDocumentShared(tx, documentId);
      const created = await tx.documentUpdate.createMany({
        data: [{ documentId, update: Buffer.from(update), updateHash: hashUpdate(update) }],
        skipDuplicates: true,
      });
      if (created.count === 0) {
        const current = await tx.document.findUniqueOrThrow({
          where: { id: documentId },
          select: { revision: true },
        });
        return { inserted: false, revision: Number(current.revision) };
      }
      const [row] = await tx.$queryRaw<{ revision: bigint }[]>`
        UPDATE documents SET revision = revision + 1, content_updated_at = now()
        WHERE id = ${documentId}::uuid RETURNING revision`;
      return { inserted: true, revision: Number(row?.revision ?? 0) };
    });
  }

  /**
   * Folds the log tail into the compacted state and deletes the folded rows. Idempotent and safe to run
   * concurrently: the exclusive advisory lock serialises compactions and waits for in-flight appends.
   */
  async compact(documentId: string): Promise<CompactionResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockDocumentExclusive(tx, documentId);
      const state = await tx.documentState.findUnique({ where: { documentId } });
      const rows = await tx.documentUpdate.findMany({
        where: { documentId, id: { gt: state?.lastUpdateId ?? 0n } },
        orderBy: { id: 'asc' },
        select: { id: true, update: true },
      });
      if (rows.length === 0) return { folded: 0, skipped: 0 };

      const doc = new Y.Doc();
      let skipped = 0;
      if (state) Y.applyUpdate(doc, new Uint8Array(state.state));
      for (const row of rows) {
        try {
          Y.applyUpdate(doc, new Uint8Array(row.update));
        } catch {
          skipped += 1;
        }
      }
      const compacted = Buffer.from(Y.encodeStateAsUpdate(doc));
      doc.destroy();
      const lastUpdateId = rows[rows.length - 1]!.id;

      await tx.documentState.upsert({
        where: { documentId },
        create: { documentId, state: compacted, lastUpdateId },
        update: { state: compacted, lastUpdateId },
      });
      await tx.documentUpdate.deleteMany({ where: { documentId, id: { lte: lastUpdateId } } });
      return { folded: rows.length, skipped };
    });
  }
}
