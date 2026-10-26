import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DocumentStorageModule } from '../versions/document-storage.module';
import { SearchIndexService } from './search-index.service';
import { SearchMetrics } from './search-metrics';
import { SearchSyncProcessor } from './search-sync.processor';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/** The one provider of `SearchIndexService`: the worker's processor and the reindex command build on it. */
@Module({
  imports: [PrismaModule, DocumentStorageModule],
  providers: [SearchIndexService],
  exports: [SearchIndexService],
})
export class SearchIndexModule {}

@Module({
  imports: [PermissionsModule],
  controllers: [SearchController],
  providers: [SearchService, SearchMetrics],
})
export class SearchModule {}

/** Registers the `search-sync` processor; imported by the worker process only. */
@Module({ imports: [SearchIndexModule], providers: [SearchSyncProcessor] })
export class SearchWorkerModule {}
