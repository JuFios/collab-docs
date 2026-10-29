import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerException, ThrottlerModule } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { getLoggerToken } from './logger';
import {
  ClientIpThrottlerGuard,
  LoginThrottlerGuard,
  RateLimit,
  UserThrottlerGuard,
} from './throttle';

@Controller()
class Routes {
  @Get('links')
  @RateLimit.user('publicLink')
  links() {}

  @Get('tickets')
  @RateLimit.user('ticket')
  tickets() {}

  @Get('login')
  @RateLimit.login()
  login() {}

  @Get('plain')
  plain() {}
}

async function setup(limits: Record<string, number> = {}) {
  const logger = { error: vi.fn() };
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }])],
    controllers: [Routes],
    providers: [
      ClientIpThrottlerGuard,
      UserThrottlerGuard,
      LoginThrottlerGuard,
      { provide: ConfigService, useValue: { get: (key: string) => limits[key] ?? 2 } },
      { provide: getLoggerToken(ClientIpThrottlerGuard.name), useValue: logger },
      { provide: getLoggerToken(UserThrottlerGuard.name), useValue: logger },
      { provide: getLoggerToken(LoginThrottlerGuard.name), useValue: logger },
    ],
  }).compile();
  await module.init();
  const headers: Record<string, unknown> = {};
  const context = (
    handler: keyof Routes,
    request: { ip?: string; user?: { id: string }; body?: unknown },
  ): ExecutionContext =>
    ({
      getHandler: () => Routes.prototype[handler],
      getClass: () => Routes,
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, ...request }),
        getResponse: () => ({ header: (name: string, value: unknown) => (headers[name] = value) }),
      }),
    }) as unknown as ExecutionContext;
  return {
    ip: module.get(ClientIpThrottlerGuard),
    user: module.get(UserThrottlerGuard),
    login: module.get(LoginThrottlerGuard),
    context,
    headers,
    logger,
  };
}

describe('UserThrottlerGuard', () => {
  it('lets a user through up to the limit of the preset, then answers 429 with Retry-After', async () => {
    const { user, context, headers } = await setup({ RATE_PUBLIC_LINK_PER_HOUR_USER: 2 });
    const request = context('links', { ip: '1.1.1.1', user: { id: 'u1' } });
    await expect(user.canActivate(request)).resolves.toBe(true);
    await expect(user.canActivate(request)).resolves.toBe(true);
    const refused = await user.canActivate(request).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ThrottlerException);
    expect((refused as ThrottlerException).message).toBe(
      'Too many public links created, try again later',
    );
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('counts every user on its own, whatever the address', async () => {
    const { user, context } = await setup({ RATE_PUBLIC_LINK_PER_HOUR_USER: 1 });
    await expect(
      user.canActivate(context('links', { ip: '1.1.1.1', user: { id: 'a' } })),
    ).resolves.toBe(true);
    await expect(
      user.canActivate(context('links', { ip: '1.1.1.1', user: { id: 'b' } })),
    ).resolves.toBe(true);
    await expect(
      user.canActivate(context('links', { ip: '2.2.2.2', user: { id: 'a' } })),
    ).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('counts every preset on its own', async () => {
    const { user, context } = await setup({
      RATE_PUBLIC_LINK_PER_HOUR_USER: 1,
      RATE_TICKET_PER_MIN_USER: 1,
    });
    const request = { user: { id: 'a' } };
    await expect(user.canActivate(context('links', request))).resolves.toBe(true);
    await expect(user.canActivate(context('tickets', request))).resolves.toBe(true);
  });

  it('leaves a route without a user preset to the global limit', async () => {
    const { user, context } = await setup({ RATE_PUBLIC_LINK_PER_HOUR_USER: 1 });
    const request = context('plain', { user: { id: 'a' } });
    for (let i = 0; i < 5; i++) await expect(user.canActivate(request)).resolves.toBe(true);
  });

  it('lets requests through when the storage is down', async () => {
    const { user, context, logger } = await setup();
    vi.spyOn(
      (user as unknown as { storageService: { increment: () => unknown } }).storageService,
      'increment',
    ).mockRejectedValue(new Error('redis is down'));
    await expect(user.canActivate(context('links', { user: { id: 'u' } }))).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('ClientIpThrottlerGuard', () => {
  it('applies the per-IP preset of the route, and ignores per-user presets', async () => {
    const { ip, context } = await setup({ RATE_LOGIN_PER_MIN_IP: 1 });
    await expect(ip.canActivate(context('login', { ip: '1.1.1.1' }))).resolves.toBe(true);
    await expect(ip.canActivate(context('login', { ip: '2.2.2.2' }))).resolves.toBe(true);
    await expect(ip.canActivate(context('login', { ip: '1.1.1.1' }))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    const links = context('links', { ip: '3.3.3.3', user: { id: 'u' } });
    for (let i = 0; i < 5; i++) await expect(ip.canActivate(links)).resolves.toBe(true);
  });
});

describe('LoginThrottlerGuard', () => {
  it('limits attempts per address and email, however the email is written', async () => {
    const { login, context, headers } = await setup({
      RATE_LOGIN_PER_MIN_IP_EMAIL: 2,
      RATE_LOGIN_PER_MIN_IP: 100,
    });
    const attempt = (ip: string, email: string) =>
      login.canActivate(context('login', { ip, body: { email, password: 'x' } }));
    await expect(attempt('1.1.1.1', 'ada@example.test')).resolves.toBe(true);
    await expect(attempt('1.1.1.1', ' ADA@example.test ')).resolves.toBe(true);
    const refused = await attempt('1.1.1.1', 'ada@example.test').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ThrottlerException);
    expect((refused as ThrottlerException).message).toBe(
      'Too many login attempts, try again later',
    );
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
    expect(headers['X-RateLimit-Login-Remaining']).toBe(0);
    expect(headers['X-RateLimit-Remaining']).toBeUndefined();
    // another email from the same address, and the same email from another address, have counters of their own
    await expect(attempt('1.1.1.1', 'bob@example.test')).resolves.toBe(true);
    await expect(attempt('2.2.2.2', 'ada@example.test')).resolves.toBe(true);
  });
});
