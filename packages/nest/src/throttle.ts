import {
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  seconds,
} from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Redis } from 'ioredis';
import type { AppConfig } from './config';
import { getRootLogger } from './logger';

export function throttlerOptions(
  config: ConfigService<AppConfig, true>,
  redis: Redis,
): ThrottlerModuleOptions {
  return {
    throttlers: [
      {
        name: 'default',
        ttl: seconds(60),
        limit: config.get('RATE_GLOBAL_PER_MIN_IP', { infer: true }),
      },
    ],
    storage: new ThrottlerStorageRedisService(redis),
  };
}

/** Keys the counter by the real client IP (`req.ip` honours `trust proxy` = TRUSTED_PROXY_CIDRS only). */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  // property injection: the base class constructor takes the throttler options, storage and reflector
  @Inject() private readonly config!: ConfigService<AppConfig, true>;

  protected override handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const preset = this.reflector.getAllAndOverride<RatePreset | undefined>(RATE_LIMIT_PRESET, [
      request.context.getHandler(),
      request.context.getClass(),
    ]);
    if (!preset || request.throttler.name !== 'default') return super.handleRequest(request);
    const { limit, ttl } = PRESETS[preset];
    return super.handleRequest({
      ...request,
      limit: Number(this.config.get(limit, { infer: true })),
      ttl,
      blockDuration: ttl,
    });
  }

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

type RatePreset = 'login' | 'register' | 'publicLink' | 'ticket';

/** Env key holding the limit, and the window, of each per-route preset. */
const PRESETS: Record<RatePreset, { limit: keyof AppConfig; ttl: number }> = {
  login: { limit: 'RATE_LOGIN_PER_MIN_IP', ttl: seconds(60) },
  register: { limit: 'RATE_REGISTER_PER_HOUR_IP', ttl: seconds(3600) },
  publicLink: { limit: 'RATE_PUBLIC_LINK_PER_HOUR_USER', ttl: seconds(3600) },
  ticket: { limit: 'RATE_TICKET_PER_MIN_USER', ttl: seconds(60) },
};

const RATE_LIMIT_PRESET = 'rate-limit:preset';

/**
 * Per-route presets (limits come from env; see README). Applied by the owning stage, e.g.
 * `@RateLimit.login()` on the login handler. `ClientIpThrottlerGuard` swaps the preset's limit and window in for
 * the `default` throttler on that route, replacing the global limit.
 */
export const RateLimit = {
  login: () => SetMetadata(RATE_LIMIT_PRESET, 'login'),
  register: () => SetMetadata(RATE_LIMIT_PRESET, 'register'),
  publicLink: () => SetMetadata(RATE_LIMIT_PRESET, 'publicLink'),
  ticket: () => SetMetadata(RATE_LIMIT_PRESET, 'ticket'),
};
