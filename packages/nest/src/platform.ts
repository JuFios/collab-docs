import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { appConfigModule } from './app-config';
import type { AppConfig } from './config';
import { HealthModule } from './health';
import { PlatformLoggerModule } from './logger';
import { MetricsModule } from './metrics';
import { QueueModule } from './queue';
import { RequestPipelineModule } from './pipeline';
import { REDIS_CLIENT, RedisModule } from './redis';
import { ClientIpThrottlerGuard, throttlerOptions } from './throttle';

/** Everything an HTTP service needs from the platform: config, logs, metrics, health, Redis, queues, rate limiting. */
@Module({})
export class PlatformModule {
  static forRoot(): DynamicModule {
    return {
      module: PlatformModule,
      imports: [
        appConfigModule(),
        PlatformLoggerModule,
        RequestPipelineModule,
        RedisModule,
        MetricsModule,
        QueueModule,
        HealthModule,
        ThrottlerModule.forRootAsync({
          inject: [ConfigService, REDIS_CLIENT],
          useFactory: (config: ConfigService<AppConfig, true>, redis: Redis) =>
            throttlerOptions(config, redis),
        }),
      ],
      providers: [{ provide: APP_GUARD, useClass: ClientIpThrottlerGuard }],
    };
  }
}

/** Platform for the queue worker process: no HTTP surface, so no rate limiting or probes. */
@Module({})
export class WorkerPlatformModule {
  static forRoot(): DynamicModule {
    return {
      module: WorkerPlatformModule,
      imports: [appConfigModule(), PlatformLoggerModule, RedisModule, MetricsModule, QueueModule],
    };
  }
}
