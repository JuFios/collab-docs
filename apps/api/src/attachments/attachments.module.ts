import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage';
import { WorkspacesModule } from '../workspaces';
import { AttachmentCleanupProcessor } from './attachment-cleanup.processor';
import { AttachmentSweeper } from './attachment-sweeper';
import { AttachmentAccessGuard } from './attachment-access';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { DocumentAttachmentsController } from './document-attachments.controller';

@Module({
  imports: [StorageModule, WorkspacesModule],
  controllers: [DocumentAttachmentsController, AttachmentsController],
  providers: [AttachmentsService, AttachmentSweeper, AttachmentAccessGuard],
  exports: [AttachmentSweeper],
})
export class AttachmentsModule {}

/** Registers the hourly sweep of abandoned uploads; imported by the worker process only. */
@Module({
  imports: [PrismaModule, StorageModule],
  providers: [AttachmentSweeper, AttachmentCleanupProcessor],
})
export class AttachmentsWorkerModule {}
