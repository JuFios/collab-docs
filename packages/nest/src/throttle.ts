import {
  type ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
  seconds,
} from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Redis } from 'ioredis';
import type { AppConfig } from './config';
import { InjectPinoLogger, PinoLogger } from './logger';

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

/** Where a preset's counter is kept: per client address, or per signed-in user. */
type RateScope = 'ip' | 'user';

/** Env key holding the limit, the window, the counter's scope and the message of the 429 of each preset. */
const PRESETS = {
  login: { scope: 'ip', limit: 'RATE_LOGIN_PER_MIN_IP', ttl: seconds(60) },
  register: { scope: 'ip', limit: 'RATE_REGISTER_PER_HOUR_IP', ttl: seconds(3600) },
  guestTicket: { scope: 'ip', limit: 'RATE_GUEST_TICKET_PER_MIN_IP', ttl: seconds(60) },
  ticket: {
    scope: 'user',
    limit: 'RATE_TICKET_PER_MIN_USER',
    ttl: seconds(60),
    message: 'Too many connection attempts, try again shortly',
  },
  publicLink: {
    scope: 'user',
    limit: 'RATE_PUBLIC_LINK_PER_HOUR_USER',
    ttl: seconds(3600),
    message: 'Too many public links created, try again later',
  },
  search: {
    scope: 'user',
    limit: 'RATE_SEARCH_PER_MIN_USER',
    ttl: seconds(60),
    message: 'Too many searches, try again shortly',
  },
} as const satisfies Record<
  string,
  { scope: RateScope; limit: keyof AppConfig; ttl: number; message?: string }
>;
type RatePreset = keyof typeof PRESETS;
type PresetOf<S extends RateScope> = {
  [P in RatePreset]: (typeof PRESETS)[P]['scope'] extends S ? P : never;
}[RatePreset];

const RATE_LIMIT_PRESET = 'rate-limit:preset';

/**
 * Keys the counter by the real client IP (`req.ip` honours `trust proxy` = TRUSTED_PROXY_CIDRS only). Runs
 * globally; a route's per-IP preset swaps its env limit and window in for the `default` throttler.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected readonly scope: RateScope = 'ip';

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(ClientIpThrottlerGuard.name) private readonly pino: PinoLogger,
  ) {
    super(options, storageService, reflector);
  }

  protected override handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const preset = this.presetOf(request.context);
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

  protected override async getErrorMessage(
    context: ExecutionContext,
    detail: Parameters<ThrottlerGuard['getErrorMessage']>[1],
  ): Promise<string> {
    const preset = this.presetOf(context);
    const custom = preset ? (PRESETS[preset] as { message?: string }).message : undefined;
    return custom ?? super.getErrorMessage(context, detail);
  }

  /** The route's preset, if it belongs to this guard's scope. */
  private presetOf(context: ExecutionContext): RatePreset | undefined {
    const preset = this.reflector.getAllAndOverride<RatePreset | undefined>(RATE_LIMIT_PRESET, [
      context.getHandler(),
      context.getClass(),
    ]);
    return preset && PRESETS[preset].scope === this.scope ? preset : undefined;
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

/**
 * Keys the counter by the signed-in user (`@RateLimit.user(...)`): tickets are fetched on every reconnect of every
 * tab and public links are created by people, not by addresses. A route-level guard, so it runs after the global
 * auth guard and `request.user` is set.
 */
@Injectable()
export class UserThrottlerGuard extends ClientIpThrottlerGuard {
  protected override readonly scope: RateScope = 'user';

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(UserThrottlerGuard.name) pino: PinoLogger,
  ) {
    super(options, storageService, reflector, config, pino);
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = (req.user as { id?: string } | undefined)?.id;
    return userId ? `user:${userId}` : super.getTracker(req);
  }
}

/**
 * Per-route presets (limits come from env; see README). `login`, `register` and `guestTicket` count per client IP,
 * `ticket`, `publicLink` and `search` per signed-in user, which needs the route to be authenticated.
 */
export const RateLimit = {
  login: () => SetMetadata(RATE_LIMIT_PRESET, 'login' satisfies PresetOf<'ip'>),
  register: () => SetMetadata(RATE_LIMIT_PRESET, 'register' satisfies PresetOf<'ip'>),
  guestTicket: () => SetMetadata(RATE_LIMIT_PRESET, 'guestTicket' satisfies PresetOf<'ip'>),
  user: (preset: PresetOf<'user'>) =>
    applyDecorators(SetMetadata(RATE_LIMIT_PRESET, preset), UseGuards(UserThrottlerGuard)),
};
