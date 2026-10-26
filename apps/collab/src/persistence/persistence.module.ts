import { Module } from '@nestjs/common';
import {
  DocumentStateReader,
  DocumentStateWriter,
  DocumentVersions,
  PrismaClient,
} from '@collab-docs/db';
import { APP_CONFIG, type AppConfig, getRootLogger } from '@collab-docs/nest';
import { CollabMetrics } from '../metrics/collab-metrics.service';
import { DOCUMENT_STORE } from '../rooms/document-store';
import { type DocumentStorage, PostgresDocumentStore } from '../rooms/postgres-document-store';
import { PersistenceHooksService } from './persistence-hooks.service';

/** Storage of document content: the Postgres-backed `DocumentStore` and what hangs off it (versions, restore). */
@Module({
  providers: [
    {
      provide: DocumentStateReader,
      inject: [PrismaClient],
      useFactory: (prisma: PrismaClient) => new DocumentStateReader(prisma),
    },
    {
      provide: DocumentVersions,
      inject: [PrismaClient, DocumentStateReader],
      useFactory: (prisma: PrismaClient, reader: DocumentStateReader) =>
        new DocumentVersions(prisma, reader),
    },
    PersistenceHooksService,
    {
      provide: DOCUMENT_STORE,
      inject: [
        PrismaClient,
        DocumentStateReader,
        APP_CONFIG,
        CollabMetrics,
        PersistenceHooksService,
      ],
      useFactory: (
        prisma: PrismaClient,
        reader: DocumentStateReader,
        config: AppConfig,
        metrics: CollabMetrics,
        hooks: PersistenceHooksService,
      ) => {
        const writer = new DocumentStateWriter(prisma);
        const storage: DocumentStorage = {
          read: (documentId) => reader.read(documentId),
          append: (documentId, update) => writer.append(documentId, update),
          compact: (documentId) => writer.compact(documentId),
        };
        return new PostgresDocumentStore(
          storage,
          {
            flushIntervalMs: config.COLLAB_FLUSH_INTERVAL_MS,
            flushMaxWaitMs: config.COLLAB_FLUSH_MAX_WAIT_MS,
            compactMaxRows: config.COLLAB_COMPACT_MAX_ROWS,
            compactMaxBytes: config.COLLAB_COMPACT_MAX_BYTES,
          },
          metrics,
          hooks,
          getRootLogger(),
        );
      },
    },
  ],
  exports: [DOCUMENT_STORE, DocumentVersions, DocumentStateReader],
})
export class PersistenceModule {}
