import { Injectable } from '@nestjs/common';
import { DocumentStateReader, Prisma } from '@collab-docs/db';
import { plainSearchText } from '@collab-docs/shared';
import { extractPlainText, sanitizeContent, yDocToContentJson } from '@collab-docs/shared/content';
import {
  InjectPinoLogger,
  PinoLogger,
  QUEUE_NAMES,
  QueueService,
  enqueueDebounced,
  logEvent,
} from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Text beyond this is not searchable. `tsvector` holds at most 1 MB, and a longer value fails the whole job
 * ("string is too long for tsvector"), which would leave the document unindexed instead of partly indexed.
 */
export const MAX_INDEXED_BODY_CHARS = 200_000;

const REINDEX_BATCH = 200;

export type IndexOutcome = 'indexed' | 'unchanged' | 'removed';

export interface IndexOptions {
  /** Rewrite a row of the same revision too (reindexing after the extraction changed), not only a newer one. */
  force?: boolean;
}

export interface ReindexSummary {
  documents: number;
  indexed: number;
  removed: number;
}

/**
 * Builds the search row of a document from its stored state (spec §7). Used by the `search-sync` worker and by the
 * reindex command; the web-facing request path never calls it, so editing and indexing stay apart.
 */
@Injectable()
export class SearchIndexService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: DocumentStateReader,
    private readonly queues: QueueService,
    @InjectPinoLogger(SearchIndexService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Brings the row of `documentId` up to date with what is stored now. Idempotent and safe to run twice, late or
   * out of order: the upsert only moves a row to a higher revision.
   */
  async index(documentId: string, options: IndexOptions = {}): Promise<IndexOutcome> {
    const document = await this.load(documentId);
    if (!document || document.deletedAt) {
      await this.remove(documentId);
      return 'removed';
    }

    // The revision is read BEFORE the state. A flush that lands in between makes the body newer than its revision
    // stamp, which only costs one more run; the other order could stamp a revision the body does not have, and the
    // run for that revision would then be skipped for good.
    const doc = await this.reader.readDoc(documentId);
    let body: string;
    try {
      body = plainSearchText(extractPlainText(sanitizeContent(yDocToContentJson(doc)))).slice(
        0,
        MAX_INDEXED_BODY_CHARS,
      );
    } finally {
      doc.destroy();
    }
    const title = plainSearchText(document.title);

    const written = await this.upsert(
      { id: document.id, workspaceId: document.workspaceId, title, body },
      document.revision,
      options.force ?? false,
    );

    // Changes made while this run was reading: another run is queued by their own event, unless the debounce
    // window swallowed it; and a delete in the meantime must not leave a row behind.
    const after = await this.load(documentId);
    if (!after || after.deletedAt) {
      await this.remove(documentId);
      return 'removed';
    }
    if (after.revision > document.revision) {
      await enqueueDebounced(
        this.queues.getQueue(QUEUE_NAMES.searchSync),
        documentId,
        this.queues.setting('SEARCH_DEBOUNCE_MS'),
        { revision: Number(after.revision), reason: 'revision_advanced' },
      );
    }

    const lagSeconds = Math.max(0, (Date.now() - changedAt(document).getTime()) / 1000);
    logEvent(this.logger, 'search.indexed', {
      documentId,
      workspaceId: document.workspaceId,
      revision: Number(document.revision),
      outcome: written ? 'indexed' : 'unchanged',
      bodyChars: body.length,
      lagSeconds: Math.round(lagSeconds * 1000) / 1000,
    });
    return written ? 'indexed' : 'unchanged';
  }

  /** Rebuilds the rows of one workspace (or, without a scope, of all of them); rows of deleted documents are dropped. */
  async reindex(
    scope: { workspaceId?: string } = {},
    onProgress?: (summary: ReindexSummary) => void,
  ): Promise<ReindexSummary> {
    const summary: ReindexSummary = { documents: 0, indexed: 0, removed: 0 };
    let after: string | undefined;
    for (;;) {
      const batch = await this.prisma.document.findMany({
        where: { workspaceId: scope.workspaceId },
        orderBy: { id: 'asc' },
        take: REINDEX_BATCH,
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        select: { id: true },
      });
      if (batch.length === 0) return summary;
      for (const { id } of batch) {
        const outcome = await this.index(id, { force: true });
        summary.documents += 1;
        if (outcome === 'indexed') summary.indexed += 1;
        if (outcome === 'removed') summary.removed += 1;
      }
      after = batch.at(-1)?.id;
      onProgress?.(summary);
    }
  }

  // --- helpers --------------------------------------------------------------------------------------------

  private load(documentId: string) {
    return this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        revision: true,
        deletedAt: true,
        updatedAt: true,
        contentUpdatedAt: true,
      },
    });
  }

  private async remove(documentId: string): Promise<void> {
    const { count } = await this.prisma.documentSearch.deleteMany({ where: { documentId } });
    if (count > 0) logEvent(this.logger, 'search.removed', { documentId });
  }

  /** `true` when the row was written, `false` when it already had this revision or a newer one. */
  private async upsert(
    row: { id: string; workspaceId: string; title: string; body: string },
    revision: bigint,
    force: boolean,
  ): Promise<boolean> {
    const written = await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO document_search (document_id, workspace_id, title, body, indexed_revision, indexed_at)
      VALUES (${row.id}::uuid, ${row.workspaceId}::uuid, ${row.title}, ${row.body}, ${revision}, now())
      ON CONFLICT (document_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        indexed_revision = EXCLUDED.indexed_revision,
        indexed_at = EXCLUDED.indexed_at
      WHERE document_search.indexed_revision ${force ? Prisma.sql`<=` : Prisma.sql`<`} EXCLUDED.indexed_revision`);
    return written > 0;
  }
}

function changedAt(document: { updatedAt: Date; contentUpdatedAt: Date | null }): Date {
  return document.contentUpdatedAt && document.contentUpdatedAt > document.updatedAt
    ? document.contentUpdatedAt
    : document.updatedAt;
}
