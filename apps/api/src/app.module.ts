import { Module } from '@nestjs/common';
import { PlatformModule } from '@collab-docs/shared/nest';
import { AuthModule } from './auth';
import { PrismaModule } from './prisma/prisma.module';

@Module({ imports: [PlatformModule.forRoot(), PrismaModule, AuthModule] })
export class AppModule {}
