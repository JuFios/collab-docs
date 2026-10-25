import * as Y from 'yjs';
import type { Prisma, PrismaClient } from '../generated/client';

/** A document as stored: the compacted state with the log tail folded in. */
export interface LoadedDocumentState {
  /** The whole document as one Yjs update; `null` for a document that was never edited. */
  update: Uint8Array | null;
  /** State vector of `update`: everything it covers is durable. */
  stateVector: Uint8Array;
  /** Rows of the log after the compacted state, and their size; the inputs of the compaction thresholds. */
  tailRows: number;
  tailBytes: number;
  /** Tail rows that could not be decoded and were left out (logged by the caller, never fatal). */
  skippedRows: number;
}

const EMPTY_STATE_VECTOR = Y.encodeStateVector(new Y.Doc());

function foldUpdates(parts: Uint8Array[]): { update: Uint8Array | null; skipped: number } {
  if (parts.length === 0) return { update: null, skipped: 0 };
  try {
    return { update: Y.mergeUpdates(parts), skipped: 0 };
  } catch {
    // at least one part is corrupt: apply them one by one and drop the ones that do not apply
    const doc = new Y.Doc();
    let skipped = 0;
    for (const part of parts) {
      try {
        Y.applyUpdate(doc, part);
      } catch {
        skipped += 1;
      }
    }
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return { update, skipped };
  }
}

/**
 * Reads a document's content from storage. Shared by the collab service (cold start), version previews and
 * the workers that derive data from the content (search, publishing).
 */
export class DocumentStateReader {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * One consistent snapshot of state + tail. Without the repeatable-read transaction a compaction between the
   * two reads could delete tail rows the first read did not include in the state.
   */
  async read(documentId: string): Promise<LoadedDocumentState> {
    return this.prisma.$transaction((tx) => this.readWith(tx, documentId), {
      isolationLevel: 'RepeatableRead',
    });
  }

  async readWith(tx: Prisma.TransactionClient, documentId: string): Promise<LoadedDocumentState> {
    const state = await tx.documentState.findUnique({ where: { documentId } });
    const rows = await tx.documentUpdate.findMany({
      where: { documentId, id: { gt: state?.lastUpdateId ?? 0n } },
      orderBy: { id: 'asc' },
      select: { update: true },
    });
    const parts = [...(state ? [state.state] : []), ...rows.map((row) => row.update)];
    const { update, skipped } = foldUpdates(parts.map((part) => new Uint8Array(part)));
    return {
      update,
      stateVector: update ? Y.encodeStateVectorFromUpdate(update) : EMPTY_STATE_VECTOR,
      tailRows: rows.length,
      tailBytes: rows.reduce((total, row) => total + row.update.byteLength, 0),
      skippedRows: skipped,
    };
  }

  /** The stored document as a `Y.Doc` (the caller destroys it). */
  async readDoc(documentId: string): Promise<Y.Doc> {
    const { update } = await this.read(documentId);
    const doc = new Y.Doc();
    if (update) Y.applyUpdate(doc, update);
    return doc;
  }
}
