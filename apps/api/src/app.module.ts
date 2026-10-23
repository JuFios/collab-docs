import { Module } from '@nestjs/common';
import { PlatformModule } from '@collab-docs/shared/nest';
import { AuthModule } from './auth';
import { PermissionsModule } from './permissions';
import { PrismaModule } from './prisma/prisma.module';
import { WorkspacesModule } from './workspaces';

@Module({
  imports: [
    PlatformModule.forRoot(),
    PrismaModule,
    AuthModule,
    PermissionsModule,
    WorkspacesModule,
  ],
})
export class AppModule {}
