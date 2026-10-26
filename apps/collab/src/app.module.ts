import { Module } from '@nestjs/common';
import {
  RequestPipelineModule,
  appConfigModule,
  HealthModule,
  MetricsModule,
  platformLoggerModule,
  QueueModule,
  RedisModule,
} from '@collab-docs/nest';
import { CollabModule } from './collab.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    appConfigModule(),
    RequestPipelineModule,
    platformLoggerModule(),
    RedisModule,
    MetricsModule,
    QueueModule,
    HealthModule,
    PrismaModule,
    CollabModule,
  ],
})
export class AppModule {}
