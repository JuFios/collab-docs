import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  HealthModule,
  MetricsModule,
  PlatformLoggerModule,
  QueueModule,
  RedisModule,
} from '@collab-docs/shared/nest';
import { CollabModule } from './collab.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    AppConfigModule.forRoot(),
    PlatformLoggerModule,
    RedisModule,
    MetricsModule,
    QueueModule,
    HealthModule,
    PrismaModule,
    CollabModule,
  ],
})
export class AppModule {}
