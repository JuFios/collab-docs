import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DocumentStateReader,
  DocumentStateWriter,
  DocumentVersions,
  PrismaClient,
} from '@collab-docs/db';
import { type AppConfig, PinoLogger } from '@collab-docs/nest';
import { CollabMetrics } from '../metrics/collab-metrics.service';
import { DOCUMENT_STORE } from '../rooms/document-store';
import { type DocumentStorage, PostgresDocumentStore } from '../rooms/postgres-document-store';
import { PersistenceHooksService } from './persistence-hooks.service';
import { PrismaService } from '../prisma/prisma.service';

/** Storage of document content: the Postgres-backed `DocumentStore` and what hangs off it (versions, restore). */
@Module({
  providers: [
    {
      provide: DocumentStateReader,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new DocumentStateReader(prisma),
    },
    {
      provide: DocumentVersions,
      inject: [PrismaService, DocumentStateReader],
      useFactory: (prisma: PrismaService, reader: DocumentStateReader) =>
        new DocumentVersions(prisma, reader),
    },
    PersistenceHooksService,
    {
      provide: DOCUMENT_STORE,
      inject: [
        PrismaService,
        DocumentStateReader,
        ConfigService,
        CollabMetrics,
        PersistenceHooksService,
        PinoLogger,
      ],
      useFactory: (
        prisma: PrismaClient,
        reader: DocumentStateReader,
        config: ConfigService<AppConfig, true>,
        metrics: CollabMetrics,
        hooks: PersistenceHooksService,
        logger: PinoLogger,
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
            flushIntervalMs: config.get('COLLAB_FLUSH_INTERVAL_MS', { infer: true }),
            flushMaxWaitMs: config.get('COLLAB_FLUSH_MAX_WAIT_MS', { infer: true }),
            compactMaxRows: config.get('COLLAB_COMPACT_MAX_ROWS', { infer: true }),
            compactMaxBytes: config.get('COLLAB_COMPACT_MAX_BYTES', { infer: true }),
          },
          metrics,
          hooks,
          logger.logger,
        );
      },
    },
  ],
  exports: [DOCUMENT_STORE, DocumentVersions, DocumentStateReader],
})
export class PersistenceModule {}
