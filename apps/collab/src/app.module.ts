import { Module } from '@nestjs/common';
import {
  RequestPipelineModule,
  appConfigModule,
  HealthModule,
  MetricsModule,
  PlatformLoggerModule,
  QueueModule,
  RedisModule,
} from '@collab-docs/nest';
import { CollabModule } from './collab.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    appConfigModule(),
    RequestPipelineModule,
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
