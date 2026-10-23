import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';
import { TreeCacheService } from './tree-cache.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [DocumentsController, SharesController],
  providers: [DocumentsService, SharesService, TreeCacheService],
})
export class DocumentsModule {}
