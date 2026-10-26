import { type ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Throttle, ThrottlerGuard, type ThrottlerModuleOptions, seconds } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Redis } from 'ioredis';
import { currentConfig } from './app-config';
import type { AppConfig } from './config';
import { getRootLogger } from './logger';

export function throttlerOptions(config: AppConfig, redis: Redis): ThrottlerModuleOptions {
  return {
    throttlers: [{ name: 'default', ttl: seconds(60), limit: config.RATE_GLOBAL_PER_MIN_IP }],
    storage: new ThrottlerStorageRedisService(redis),
  };
}

/** Keys the counter by the real client IP (`req.ip` honours `trust proxy` = TRUSTED_PROXY_CIDRS only). */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return typeof req.ip === 'string' ? req.ip : 'unknown';
  }

  /** Fail open: a Redis outage must degrade rate limiting, not take the API down. */
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      getRootLogger().error({ err: error }, 'rate limiter unavailable, allowing request');
      return true;
    }
  }
}

const perMinute = () => seconds(60);
const perHour = () => seconds(3600);

/**
 * Per-route presets (limits come from env; see README). Applied by the owning stage, e.g.
 * `@RateLimit.login()` on the login handler. They all share the `default` throttler, replacing the global limit.
 */
export const RateLimit = {
  login: () =>
    Throttle({ default: { limit: () => currentConfig().RATE_LOGIN_PER_MIN_IP, ttl: perMinute } }),
  register: () =>
    Throttle({ default: { limit: () => currentConfig().RATE_REGISTER_PER_HOUR_IP, ttl: perHour } }),
  publicLink: () =>
    Throttle({
      default: { limit: () => currentConfig().RATE_PUBLIC_LINK_PER_HOUR_USER, ttl: perHour },
    }),
  ticket: () =>
    Throttle({
      default: { limit: () => currentConfig().RATE_TICKET_PER_MIN_USER, ttl: perMinute },
    }),
};
