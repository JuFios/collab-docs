import { Module } from '@nestjs/common';
import { PlatformModule } from '@collab-docs/nest';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { CollabModule } from './collab/collab.module';
import { CommentsModule } from './comments/comments.module';
import { DocumentsModule } from './documents/documents.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { PublishingModule } from './publishing/publishing.module';
import { RealtimeEventsModule } from './realtime/realtime.module';
import { SearchModule } from './search/search.module';
import { VersionsModule } from './versions/versions.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    PlatformModule.forRoot(),
    PrismaModule,
    AuthModule,
    WorkspacesModule,
    RealtimeEventsModule,
    DocumentsModule,
    CollabModule,
    VersionsModule,
    AttachmentsModule,
    PublishingModule,
    SearchModule,
    NotificationsModule,
    CommentsModule,
    BillingModule,
  ],
})
export class AppModule {}
