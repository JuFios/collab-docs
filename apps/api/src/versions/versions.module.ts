import { Module } from '@nestjs/common';
import { DocumentStateReader, DocumentVersions } from '@collab-docs/db';
import { CollabModule } from '../collab/collab.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { PrismaModule } from '../prisma/prisma.module';
import { VersionPruneProcessor } from './version-prune.processor';
import { VersionsController } from './versions.controller';
import { VersionsService } from './versions.service';
import { PrismaService } from '../prisma/prisma.service';

const storage = [
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
];

@Module({
  imports: [CollabModule, PermissionsModule],
  controllers: [VersionsController],
  providers: [...storage, VersionsService],
  exports: [DocumentStateReader, DocumentVersions],
})
export class VersionsModule {}

/** Registers the retention job; imported by the worker process only. */
@Module({ imports: [PrismaModule], providers: [...storage, VersionPruneProcessor] })
export class VersionsWorkerModule {}
