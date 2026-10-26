import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  seconds,
} from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Redis } from 'ioredis';
import type { AppConfig } from './config';
import { AppException } from './exceptions';
import { InjectPinoLogger, PinoLogger } from './logger';
import { REDIS_CLIENT } from './redis';

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
  @InjectPinoLogger(ClientIpThrottlerGuard.name) private readonly pino!: PinoLogger;

  protected override handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const preset = this.reflector.getAllAndOverride<IpRatePreset | undefined>(RATE_LIMIT_PRESET, [
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
      this.pino.error({ err: error }, 'rate limiter unavailable, allowing request');
      return true;
    }
  }
}

/** Presets counted per client IP by the global guard; the limit comes from env and replaces the global one. */
type IpRatePreset = 'login' | 'register' | 'guestTicket';
/** Presets counted per signed-in user by `UserRateLimitGuard`. */
type UserRatePreset = 'ticket' | 'publicLink';

/** Env key holding the limit, and the window, of each per-IP preset. */
const PRESETS: Record<IpRatePreset, { limit: keyof AppConfig; ttl: number }> = {
  login: { limit: 'RATE_LOGIN_PER_MIN_IP', ttl: seconds(60) },
  register: { limit: 'RATE_REGISTER_PER_HOUR_IP', ttl: seconds(3600) },
  guestTicket: { limit: 'RATE_GUEST_TICKET_PER_MIN_IP', ttl: seconds(60) },
};

/** Per-user presets: limit, window and the message of the 429. */
const USER_PRESETS: Record<
  UserRatePreset,
  { limit: keyof AppConfig; ttl: number; message: string }
> = {
  ticket: {
    limit: 'RATE_TICKET_PER_MIN_USER',
    ttl: seconds(60),
    message: 'Too many connection attempts, try again shortly',
  },
  publicLink: {
    limit: 'RATE_PUBLIC_LINK_PER_HOUR_USER',
    ttl: seconds(3600),
    message: 'Too many public links created, try again later',
  },
};

const RATE_LIMIT_PRESET = 'rate-limit:preset';
const USER_RATE_LIMIT_PRESET = 'rate-limit:user-preset';

/**
 * Per-route presets (limits come from env; see README). `ClientIpThrottlerGuard` swaps the preset's limit and
 * window in for the `default` throttler on that route, replacing the global limit. `user(...)` counts per signed-in
 * user instead (tickets are fetched on every reconnect of every tab, public links are created by people, not
 * by addresses) and needs the route to be authenticated.
 */
export const RateLimit = {
  login: () => SetMetadata(RATE_LIMIT_PRESET, 'login'),
  register: () => SetMetadata(RATE_LIMIT_PRESET, 'register'),
  guestTicket: () => SetMetadata(RATE_LIMIT_PRESET, 'guestTicket'),
  user: (preset: UserRatePreset) =>
    applyDecorators(SetMetadata(USER_RATE_LIMIT_PRESET, preset), UseGuards(UserRateLimitGuard)),
};

/**
 * Fixed-window counter per user in Redis (`@RateLimit.user(preset)`). Runs after the global auth guard, so
 * `request.user` is set. Fails open when Redis is down, like the global limiter.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  // property injection: keeps the guard constructible without a constructor list in `@UseGuards`
  @Inject(REDIS_CLIENT) private readonly redis!: Redis;
  @Inject() private readonly reflector!: Reflector;
  @Inject() private readonly config!: ConfigService<AppConfig, true>;
  @InjectPinoLogger(UserRateLimitGuard.name) private readonly logger!: PinoLogger;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const preset = this.reflector.getAllAndOverride<UserRatePreset | undefined>(
      USER_RATE_LIMIT_PRESET,
      [context.getHandler(), context.getClass()],
    );
    if (!preset) return true;
    const request = context.switchToHttp().getRequest<{ user?: { id: string } }>();
    const userId = request.user?.id;
    if (!userId) return true; // the auth guard has already rejected anonymous callers
    const { limit, ttl, message } = USER_PRESETS[preset];
    const windowSeconds = Math.ceil(ttl / 1000);
    const key = `rl:${preset}:${userId}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, windowSeconds);
      if (count <= Number(this.config.get(limit, { infer: true }))) return true;
      const remaining = await this.redis.ttl(key);
      throw new AppException('RATE_LIMITED', message, {
        headers: { 'Retry-After': String(remaining > 0 ? remaining : windowSeconds) },
      });
    } catch (error) {
      if (error instanceof AppException) throw error;
      this.logger.error({ err: error, preset }, 'user rate limiter unavailable, allowing request');
      return true;
    }
  }
}
