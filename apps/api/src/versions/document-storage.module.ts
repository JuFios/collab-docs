import { Module } from '@nestjs/common';
import { DocumentStateReader, DocumentVersions } from '@collab-docs/db';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The one provider of the CRDT storage readers (document state, versions) for the api and the worker process.
 * `PrismaModule` is global but imported here so the module also stands on its own in the worker's module graph.
 */
@Module({
  imports: [PrismaModule],
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
  ],
  exports: [DocumentStateReader, DocumentVersions],
})
export class DocumentStorageModule {}
