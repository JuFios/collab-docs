import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AppException } from './exceptions';
import { UserRateLimitGuard } from './throttle';

type Preset = 'ticket' | 'publicLink' | undefined;

function setup(options: { preset?: Preset; limits?: Record<string, number>; broken?: boolean }) {
  const counts = new Map<string, number>();
  const expiries = new Map<string, number>();
  const redis = {
    incr: vi.fn(async (key: string) => {
      if (options.broken) throw new Error('redis is down');
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts.get(key) as number;
    }),
    expire: vi.fn(async (key: string, seconds: number) => void expiries.set(key, seconds)),
    ttl: vi.fn(async (key: string) => expiries.get(key) ?? -1),
  };
  const guard = new UserRateLimitGuard();
  Object.assign(guard, {
    redis,
    reflector: { getAllAndOverride: () => ('preset' in options ? options.preset : 'publicLink') },
    config: { get: (key: string) => options.limits?.[key] ?? 2 },
    logger: { error: vi.fn() },
  });
  const context = (user?: { id: string }) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;
  return { guard, redis, expiries, context };
}

describe('UserRateLimitGuard', () => {
  it('lets a user through up to the limit of the preset, then answers 429 with Retry-After', async () => {
    const { guard, context, expiries } = setup({ limits: { RATE_PUBLIC_LINK_PER_HOUR_USER: 2 } });
    const request = context({ id: 'u1' });
    await expect(guard.canActivate(request)).resolves.toBe(true);
    await expect(guard.canActivate(request)).resolves.toBe(true);
    const refused = await guard.canActivate(request).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppException);
    expect((refused as AppException).code).toBe('RATE_LIMITED');
    expect(expiries.get('rl:publicLink:u1')).toBe(3600);
  });

  it('counts every user and every preset on its own', async () => {
    const { guard, context } = setup({ limits: { RATE_PUBLIC_LINK_PER_HOUR_USER: 1 } });
    await expect(guard.canActivate(context({ id: 'a' }))).resolves.toBe(true);
    await expect(guard.canActivate(context({ id: 'b' }))).resolves.toBe(true);
    await expect(guard.canActivate(context({ id: 'a' }))).rejects.toBeInstanceOf(AppException);

    const tickets = setup({ preset: 'ticket', limits: { RATE_TICKET_PER_MIN_USER: 1 } });
    await expect(tickets.guard.canActivate(tickets.context({ id: 'a' }))).resolves.toBe(true);
    expect(tickets.expiries.get('rl:ticket:a')).toBe(60);
  });

  it('does nothing for a route without a preset or without a user', async () => {
    const none = setup({ preset: undefined });
    await expect(none.guard.canActivate(none.context({ id: 'u' }))).resolves.toBe(true);
    expect(none.redis.incr).not.toHaveBeenCalled();

    const anonymous = setup({});
    await expect(anonymous.guard.canActivate(anonymous.context())).resolves.toBe(true);
    expect(anonymous.redis.incr).not.toHaveBeenCalled();
  });

  it('lets requests through when Redis is down', async () => {
    const { guard, context } = setup({ broken: true });
    await expect(guard.canActivate(context({ id: 'u' }))).resolves.toBe(true);
  });
});
