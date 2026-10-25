import { Module } from '@nestjs/common';
import { PlatformModule } from '@collab-docs/shared/nest';
import { AttachmentsModule } from './attachments';
import { AuthModule } from './auth';
import { CollabModule } from './collab';
import { DocumentsModule } from './documents';
import { PermissionsModule } from './permissions';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeEventsModule } from './realtime';
import { VersionsModule } from './versions';
import { WorkspacesModule } from './workspaces';

@Module({
  imports: [
    PlatformModule.forRoot(),
    PrismaModule,
    AuthModule,
    PermissionsModule,
    WorkspacesModule,
    RealtimeEventsModule,
    DocumentsModule,
    CollabModule,
    VersionsModule,
    AttachmentsModule,
  ],
})
export class AppModule {}
