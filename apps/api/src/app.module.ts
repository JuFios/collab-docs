import { Module } from '@nestjs/common';
import { PlatformModule } from '@collab-docs/shared/nest';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuthModule } from './auth/auth.module';
import { CollabModule } from './collab/collab.module';
import { DocumentsModule } from './documents/documents.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeEventsModule } from './realtime/realtime.module';
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
  ],
})
export class AppModule {}
