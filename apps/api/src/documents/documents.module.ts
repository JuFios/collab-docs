import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';
import { TreeCacheService } from './tree-cache.service';
import { PermissionsModule } from '../permissions/permissions.module';
import { RealtimeEventsModule } from '../realtime/realtime.module';

@Module({
  imports: [WorkspacesModule, PermissionsModule, RealtimeEventsModule],
  controllers: [DocumentsController, SharesController],
  providers: [DocumentsService, SharesService, TreeCacheService],
})
export class DocumentsModule {}
