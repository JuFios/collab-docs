import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { AppException, type AppConfig, REDIS_CLIENT, getRootLogger } from '@collab-docs/nest';
import type { RequestUser } from '../auth/auth.types';

const WINDOW_SECONDS = 60;

/**
 * Collab tickets per user and minute (`RATE_TICKET_PER_MIN_USER`). Keyed by user rather than by IP, since
 * every reconnect of every open tab fetches one. Fails open when Redis is down, like the global limiter.
 */
@Injectable()
export class TicketThrottleGuard implements CanActivate {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const userId = request.user?.id;
    if (!userId) return true; // the auth guard has already rejected anonymous callers
    const key = `rl:collab-ticket:${userId}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, WINDOW_SECONDS);
      if (count <= this.config.get('RATE_TICKET_PER_MIN_USER', { infer: true })) return true;
      const ttl = await this.redis.ttl(key);
      throw new AppException('RATE_LIMITED', 'Too many connection attempts, try again shortly', {
        headers: { 'Retry-After': String(ttl > 0 ? ttl : WINDOW_SECONDS) },
      });
    } catch (error) {
      if (error instanceof AppException) throw error;
      getRootLogger().error({ err: error }, 'ticket rate limiter unavailable, allowing request');
      return true;
    }
  }
}
