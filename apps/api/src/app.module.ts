import { Module } from '@nestjs/common';
import { PlatformModule } from '@collab-docs/shared/nest';
import { AuthModule } from './auth';
import { DocumentsModule } from './documents';
import { PermissionsModule } from './permissions';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeEventsModule } from './realtime';
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
  ],
})
export class AppModule {}
