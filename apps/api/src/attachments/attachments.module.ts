import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage';
import { WorkspacesModule } from '../workspaces';
import { AttachmentCleanupProcessor } from './attachment-cleanup.processor';
import { AttachmentSweeper } from './attachment-sweeper';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  imports: [StorageModule, WorkspacesModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentSweeper],
  exports: [AttachmentSweeper],
})
export class AttachmentsModule {}

/** Registers the hourly sweep of abandoned uploads; imported by the worker process only. */
@Module({
  imports: [PrismaModule, StorageModule],
  providers: [AttachmentSweeper, AttachmentCleanupProcessor],
})
export class AttachmentsWorkerModule {}
