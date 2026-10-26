import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { AppConfigModule, APP_CONFIG } from './app-config';
import type { AppConfig } from './config';
import { HealthModule } from './health';
import { PlatformLoggerModule } from './logger';
import { MetricsModule } from './metrics';
import { QueueModule } from './queue';
import { REDIS_CLIENT, RedisModule } from './redis';
import { ClientIpThrottlerGuard, throttlerOptions } from './throttle';

/** Everything an HTTP service needs from the platform: config, logs, metrics, health, Redis, queues, rate limiting. */
@Module({})
export class PlatformModule {
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: PlatformModule,
      imports: [
        AppConfigModule.forRoot(config),
        PlatformLoggerModule,
        RedisModule,
        MetricsModule,
        QueueModule,
        HealthModule,
        ThrottlerModule.forRootAsync({
          inject: [APP_CONFIG, REDIS_CLIENT],
          useFactory: (appConfig: AppConfig, redis: Redis) => throttlerOptions(appConfig, redis),
        }),
      ],
      providers: [{ provide: APP_GUARD, useClass: ClientIpThrottlerGuard }],
    };
  }
}

/** Platform for the queue worker process: no HTTP surface, so no rate limiting or probes. */
@Module({})
export class WorkerPlatformModule {
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: WorkerPlatformModule,
      imports: [
        AppConfigModule.forRoot(config),
        PlatformLoggerModule,
        RedisModule,
        MetricsModule,
        QueueModule,
      ],
    };
  }
}
