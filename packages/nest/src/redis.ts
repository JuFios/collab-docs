import { Global, Inject, Injectable, type OnApplicationShutdown, Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from './app-config';
import type { AppConfig } from './config';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/** Opens connections lazily so that building the app (OpenAPI export, tests) needs no running Redis. */
export function createRedis(url: string, options: { forQueues?: boolean } = {}): Redis {
  return new Redis(url, {
    lazyConnect: true,
    // BullMQ workers need unlimited retries; request/response clients should fail fast.
    maxRetriesPerRequest: options.forQueues ? null : 2,
  });
}

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createRedis(config.REDIS_URL),
    },
    RedisLifecycle,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
