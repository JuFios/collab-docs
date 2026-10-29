import { createHash } from 'node:crypto';
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

/** Where a preset's counter is kept: per client address, per signed-in user, or per address and login email. */
type RateScope = 'ip' | 'user' | 'ipEmail';

/** Env key holding the limit, the window, the counter's scope and the message of the 429 of each preset. */
const PRESETS = {
  login: { scope: 'ip', limit: 'RATE_LOGIN_PER_MIN_IP', ttl: seconds(60) },
  loginAttempt: {
    scope: 'ipEmail',
    limit: 'RATE_LOGIN_PER_MIN_IP_EMAIL',
    ttl: seconds(60),
    message: 'Too many login attempts, try again later',
  },
  register: { scope: 'ip', limit: 'RATE_REGISTER_PER_HOUR_IP', ttl: seconds(3600) },
  guestTicket: { scope: 'ip', limit: 'RATE_GUEST_TICKET_PER_MIN_IP', ttl: seconds(60) },
  mockProvider: { scope: 'ip', limit: 'RATE_MOCK_PROVIDER_PER_MIN_IP', ttl: seconds(60) },
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
  comment: {
    scope: 'user',
    limit: 'RATE_COMMENT_PER_MIN_USER',
    ttl: seconds(60),
    message: 'Too many comments, try again shortly',
  },
  // every invite (a re-issued one too) sends an email
  invite: {
    scope: 'user',
    limit: 'RATE_INVITE_PER_HOUR_USER',
    ttl: seconds(3600),
    message: 'Too many invitations sent, try again later',
  },
  // an unknown address answers 404, so the limit also bounds probing which emails have an account
  share: {
    scope: 'user',
    limit: 'RATE_SHARE_PER_MIN_USER',
    ttl: seconds(60),
    message: 'Too many shares, try again shortly',
  },
} as const satisfies Record<
  string,
  { scope: RateScope; limit: keyof AppConfig; ttl: number; message?: string }
>;
type RatePreset = keyof typeof PRESETS;
type PresetOf<S extends RateScope> = {
  [P in RatePreset]: (typeof PRESETS)[P]['scope'] extends S ? P : never;
}[RatePreset];

/** Metadata key of a route's preset (read by the guards, and by the audit of which routes are limited). */
export const RATE_LIMIT_PRESET = 'rate-limit:preset';

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
  protected presetOf(context: ExecutionContext): RatePreset | undefined {
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
 * Brute-force limit per (client IP, email) on the login route, on top of its per-IP preset. Every attempt counts,
 * successful or not; the email is normalised like the DTO does and only its hash is part of the key.
 */
@Injectable()
export class LoginThrottlerGuard extends ClientIpThrottlerGuard {
  protected override readonly scope: RateScope = 'ipEmail';
  // its own counter headers, so the per-address ones of the same response stay readable; `Retry-After` is shared
  protected override headerPrefix = 'X-RateLimit-Login';

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(LoginThrottlerGuard.name) pino: PinoLogger,
  ) {
    super(options, storageService, reflector, config, pino);
  }

  /** Attached by `RateLimit.login()` only, so its preset does not depend on the route's metadata. */
  protected override presetOf(): RatePreset {
    return 'loginAttempt';
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    const digest =
      typeof email === 'string'
        ? createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
        : 'none';
    return `login:${await super.getTracker(req)}:${digest}`;
  }
}

/**
 * Per-route presets (limits come from env; see README). `login`, `register`, `guestTicket` and `mockProvider` count per client IP
 * (`login` also per IP and email), `ticket`, `publicLink`, `search`, `comment`, `invite` and `share` per signed-in user, which needs
 * the route to be authenticated.
 */
export const RateLimit = {
  login: () =>
    applyDecorators(
      SetMetadata(RATE_LIMIT_PRESET, 'login' satisfies PresetOf<'ip'>),
      UseGuards(LoginThrottlerGuard),
    ),
  register: () => SetMetadata(RATE_LIMIT_PRESET, 'register' satisfies PresetOf<'ip'>),
  guestTicket: () => SetMetadata(RATE_LIMIT_PRESET, 'guestTicket' satisfies PresetOf<'ip'>),
  mockProvider: () => SetMetadata(RATE_LIMIT_PRESET, 'mockProvider' satisfies PresetOf<'ip'>),
  user: (preset: PresetOf<'user'>) =>
    applyDecorators(SetMetadata(RATE_LIMIT_PRESET, preset), UseGuards(UserThrottlerGuard)),
};
