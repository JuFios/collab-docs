import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DocumentStorageModule } from '../versions/document-storage.module';
import { CommentBlocksService } from './comment-blocks.service';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [PrismaModule, PermissionsModule, NotificationsModule, DocumentStorageModule],
  controllers: [CommentsController],
  providers: [CommentsService, CommentBlocksService],
})
export class CommentsModule {}
