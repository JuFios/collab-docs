import { Module } from '@nestjs/common';
import { PlatformModule } from '@collab-docs/shared/nest';
import { PrismaModule } from './prisma/prisma.module';

@Module({ imports: [PlatformModule.forRoot(), PrismaModule] })
export class AppModule {}
