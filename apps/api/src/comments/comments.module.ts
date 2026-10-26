import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DocumentStorageModule } from '../versions/document-storage.module';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [PrismaModule, PermissionsModule, InboxModule, DocumentStorageModule],
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}
