import { Module } from '@nestjs/common';
import { CollabModule } from '../collab/collab.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { DocumentStorageModule } from './document-storage.module';
import { VersionPruneProcessor } from './version-prune.processor';
import { VersionsController } from './versions.controller';
import { VersionsService } from './versions.service';

@Module({
  imports: [CollabModule, PermissionsModule, DocumentStorageModule],
  controllers: [VersionsController],
  providers: [VersionsService],
})
export class VersionsModule {}

/** Registers the retention job; imported by the worker process only. */
@Module({ imports: [DocumentStorageModule], providers: [VersionPruneProcessor] })
export class VersionsWorkerModule {}
