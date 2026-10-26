import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import {
  APP_CONFIG,
  AppException,
  type AppConfig,
  REDIS_CLIENT,
  getRootLogger,
} from '@collab-docs/nest';

const WINDOW_SECONDS = 60;

/**
 * Brute-force limit per (client IP, email), on top of the per-IP preset `@RateLimit.login()`.
 * Every attempt counts, successful or not. Fails open when Redis is down, like the global limiter.
 */
@Injectable()
export class LoginThrottleGuard implements CanActivate {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const email = (request.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== 'string') return true; // validation will reject the request
    const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    const key = `rl:login:${request.ip ?? 'unknown'}:${digest}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, WINDOW_SECONDS);
      if (count <= this.config.RATE_LOGIN_PER_MIN_IP_EMAIL) return true;
      const ttl = await this.redis.ttl(key);
      const retryAfter = ttl > 0 ? ttl : WINDOW_SECONDS;
      throw new AppException('RATE_LIMITED', 'Too many login attempts, try again later', {
        headers: { 'Retry-After': String(retryAfter) },
      });
    } catch (error) {
      if (error instanceof AppException) throw error;
      getRootLogger().error({ err: error }, 'login rate limiter unavailable, allowing request');
      return true;
    }
  }
}
