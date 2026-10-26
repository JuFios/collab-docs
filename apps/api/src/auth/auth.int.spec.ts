import '../test/auth-env';
import { Body, Controller, Get, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { PrismaClient } from '@collab-docs/db';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  authSessionSchema,
  apiErrorSchema,
  signAccessToken,
} from '@collab-docs/shared';
import { parseConfig, getRootLogger } from '@collab-docs/nest';
import { createTestApp } from '../test/test-app';
import { CurrentUser, Public } from './auth.decorators';
import type { RequestUser } from './auth.types';
import { hashToken } from './refresh-token.service';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct-horse-battery';
const EMAIL_DOMAIN = '@auth-test.example';

@Controller('test-auth')
class ProtectedController {
  @Post('echo')
  echo(@CurrentUser() user: RequestUser, @Body() body: Record<string, unknown>) {
    return { id: user.id, body };
  }

  @Get('whoami')
  whoami(@CurrentUser() user: RequestUser) {
    return { id: user.id };
  }

  @Public()
  @Post('webhook')
  webhook() {
    return { received: true };
  }
}

function cookiesOf(response: request.Response): Record<string, string> {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return Object.fromEntries((raw ?? []).map((line) => [line.split('=')[0], line]));
}

function cookieValue(line: string | undefined): string {
  return decodeURIComponent((line ?? '').split(';')[0]!.split('=').slice(1).join('='));
}

describe('auth', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  let counter = 0;
  let ipCounter = 0;
  // every request comes from its own client: rate limits are per IP and tests must not eat each other's budget
  const fresh = (path: string) =>
    http()
      .post(path)
      .set('X-Forwarded-For', `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`);
  const newEmail = () => `user-${Date.now()}-${counter++}${EMAIL_DOMAIN}`;

  async function register(email = newEmail(), name = 'Ada') {
    const response = await fresh('/api/auth/register')
      .send({ email, password: PASSWORD, name })
      .expect(201);
    const cookies = cookiesOf(response);
    return {
      email,
      body: authSessionSchema.parse(response.body),
      access: cookieValue(cookies[ACCESS_COOKIE]),
      refresh: cookieValue(cookies[REFRESH_COOKIE]),
    };
  }

  const refreshWith = (token: string, origin = ORIGIN) =>
    http()
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${token}`)
      .set('Origin', origin);

  beforeAll(async () => {
    const redis = new Redis(process.env.REDIS_URL as string);
    await redis.flushdb();
    redis.disconnect();
    app = await createTestApp([ProtectedController]);
    prisma = app.get(PrismaClient);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
    await app.close();
  });

  describe('session lifecycle', () => {
    it('register -> me -> login -> me -> refresh -> logout', async () => {
      const email = newEmail();
      const registered = await register(email, '  Ada Lovelace ');
      expect(registered.body.user).toMatchObject({ email, name: 'Ada Lovelace' });
      expect(registered.body.expiresIn).toBe(900);

      const me = await http()
        .get('/api/auth/me')
        .set('Cookie', `${ACCESS_COOKIE}=${registered.access}`)
        .expect(200);
      expect(me.body).toEqual(registered.body.user);

      const login = await fresh('/api/auth/login')
        .send({ email: email.toUpperCase(), password: PASSWORD })
        .expect(200);
      const session = authSessionSchema.parse(login.body);
      const loginCookies = cookiesOf(login);
      await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);

      const refreshed = await refreshWith(cookieValue(loginCookies[REFRESH_COOKIE])).expect(200);
      authSessionSchema.parse(refreshed.body);
      const rotated = cookieValue(cookiesOf(refreshed)[REFRESH_COOKIE]);
      expect(rotated).not.toBe(cookieValue(loginCookies[REFRESH_COOKIE]));

      const logout = await http()
        .post('/api/auth/logout')
        .set('Cookie', `${REFRESH_COOKIE}=${rotated}`)
        .set('Origin', ORIGIN)
        .expect(204);
      expect(cookiesOf(logout)[REFRESH_COOKIE]).toMatch(/Expires=Thu, 01 Jan 1970/);
      await refreshWith(rotated).expect(401);
    });

    it('sets hardened cookies with the documented attributes', async () => {
      const response = await fresh('/api/auth/register')
        .send({ email: newEmail(), password: PASSWORD, name: 'Ada' })
        .expect(201);
      const cookies = cookiesOf(response);
      expect(cookies[ACCESS_COOKIE]).toMatch(/; Path=\/;/);
      expect(cookies[ACCESS_COOKIE]).toContain('Max-Age=900');
      expect(cookies[REFRESH_COOKIE]).toContain('Path=/api/auth');
      expect(cookies[REFRESH_COOKIE]).toContain(`Max-Age=${30 * 24 * 3600}`);
      for (const line of Object.values(cookies)) {
        expect(line).toContain('HttpOnly');
        expect(line).toContain('SameSite=Lax');
        expect(line).not.toContain('Secure'); // APP_ENV=test serves plain http
      }
    });

    it('stores only a SHA-256 hash of the refresh token', async () => {
      const { refresh } = await register();
      const rows = await prisma.refreshToken.findMany({ where: { tokenHash: hashToken(refresh) } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await prisma.refreshToken.count({ where: { tokenHash: refresh } })).toBe(0);
    });

    it('stores an argon2id hash', async () => {
      const { email } = await register();
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(PASSWORD);
    });
  });

  describe('credentials', () => {
    it('answers unknown email and wrong password identically', async () => {
      const { email } = await register();
      const wrongPassword = await fresh('/api/auth/login')
        .send({ email, password: 'wrong-password-123' })
        .expect(401);
      const unknownEmail = await fresh('/api/auth/login')
        .send({ email: newEmail(), password: 'wrong-password-123' })
        .expect(401);
      const a = { ...apiErrorSchema.parse(wrongPassword.body), correlationId: '' };
      const b = { ...apiErrorSchema.parse(unknownEmail.body), correlationId: '' };
      expect(a).toEqual(b);
      expect(a.code).toBe('UNAUTHENTICATED');
    });

    it('rejects duplicate emails and weak input', async () => {
      const { email } = await register();
      const duplicate = await fresh('/api/auth/register')
        .send({ email: email.toUpperCase(), password: PASSWORD, name: 'Eve' })
        .expect(409);
      expect(duplicate.body.code).toBe('CONFLICT');

      const invalid = await fresh('/api/auth/register')
        .send({ email: 'not-an-email', password: 'short', name: '' })
        .expect(400);
      expect(invalid.body.code).toBe('VALIDATION_FAILED');
      expect(invalid.body.details.map((d: { field: string }) => d.field).sort()).toEqual([
        'email',
        'name',
        'password',
      ]);
      await fresh('/api/auth/register')
        .send({ email: newEmail(), password: PASSWORD, name: 'x'.repeat(101) })
        .expect(400);
    });
  });

  describe('access token guard', () => {
    it('requires a token and distinguishes expired from invalid', async () => {
      const none = await http().get('/api/auth/me').expect(401);
      expect(none.body.code).toBe('UNAUTHENTICATED');
      const garbage = await http()
        .get('/api/auth/me')
        .set('Authorization', 'Bearer nope')
        .expect(401);
      expect(garbage.body.code).toBe('UNAUTHENTICATED');

      const { body } = await register();
      const { token } = await signAccessToken(
        parseConfig(process.env).JWT_ACCESS_SECRET,
        body.user.id,
        {
          now: new Date(Date.now() - 3600_000),
        },
      );
      const expired = await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect(expired.body.code).toBe('TOKEN_EXPIRED');
    });

    it('is stateless: a valid token is accepted without reading the user, `me` reads the database', async () => {
      const { body } = await register();
      await prisma.user.delete({ where: { id: body.user.id } });
      const bearer = `Bearer ${body.accessToken}`;
      await http().get('/api/test-auth/whoami').set('Authorization', bearer).expect(200);
      await http().get('/api/auth/me').set('Authorization', bearer).expect(401);
    });
  });

  describe('GET /auth/refresh (browser navigation)', () => {
    const navigate = (token: string | undefined, next?: string) => {
      const req = http()
        .get('/api/auth/refresh')
        .query(next === undefined ? {} : { next });
      return token ? req.set('Cookie', `${REFRESH_COOKIE}=${token}`) : req;
    };

    it('rotates the session and redirects to the requested path', async () => {
      const { refresh } = await register();
      const response = await navigate(refresh, '/w/abc?x=1').expect(302);
      expect(response.headers.location).toBe('/w/abc?x=1');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(cookiesOf(response)[ACCESS_COOKIE]).toBeDefined();
      expect(cookiesOf(response)[REFRESH_COOKIE]).toBeDefined();
    });

    it.each(['https://evil.example', '//evil.example', '/\\evil.example', undefined])(
      'never redirects to an unsafe target (%s)',
      async (next) => {
        const { refresh } = await register();
        const response = await navigate(refresh, next).expect(302);
        expect(response.headers.location).toBe('/w');
      },
    );

    it('sends the browser to the login page and clears cookies when the session is gone', async () => {
      const response = await navigate('unknown-token', '/w/abc').expect(302);
      expect(response.headers.location).toBe('/login?next=%2Fw%2Fabc');
      expect(cookiesOf(response)[REFRESH_COOKIE]).toContain('Expires=Thu, 01 Jan 1970');
      const missing = await navigate(undefined, '/shared').expect(302);
      expect(missing.headers.location).toBe('/login?next=%2Fshared');
    });
  });

  describe('refresh rotation', () => {
    it('serves two parallel refreshes with the same token and keeps the family alive', async () => {
      const { refresh } = await register();
      const [a, b] = await Promise.all([refreshWith(refresh), refreshWith(refresh)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const issued = [a, b].map((r) => cookiesOf(r)[REFRESH_COOKIE]).filter(Boolean);
      expect(issued).toHaveLength(1); // exactly one rotation happened
      await refreshWith(cookieValue(issued[0])).expect(200);
    });

    it('revokes the whole family when a rotated token is replayed after the grace window', async () => {
      const { refresh } = await register();
      const rotated = await refreshWith(refresh).expect(200);
      const current = cookieValue(cookiesOf(rotated)[REFRESH_COOKIE]);

      await prisma.refreshToken.update({
        where: { tokenHash: hashToken(refresh) },
        data: { rotatedAt: new Date(Date.now() - 31_000) },
      });
      const replay = await refreshWith(refresh).expect(401);
      expect(replay.body.code).toBe('UNAUTHENTICATED');
      await refreshWith(current).expect(401); // the legitimate descendant is dead too
    });

    it('rejects missing, unknown and expired refresh tokens', async () => {
      await http().post('/api/auth/refresh').set('Origin', ORIGIN).expect(401);
      await refreshWith('unknown-token').expect(401);
      const { refresh } = await register();
      await prisma.refreshToken.update({
        where: { tokenHash: hashToken(refresh) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await refreshWith(refresh).expect(401);
    });
  });

  describe('csrf', () => {
    it('rejects cookie-authenticated unsafe requests from another origin or without Origin', async () => {
      const { refresh, access } = await register();
      const cookie = `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`;
      for (const path of ['/api/auth/refresh', '/api/auth/logout', '/api/test-auth/echo']) {
        const evil = await http()
          .post(path)
          .set('Cookie', cookie)
          .set('Origin', 'https://evil.example')
          .expect(403);
        expect(evil.body.code).toBe('CSRF_REJECTED');
        await http().post(path).set('Cookie', cookie).expect(403);
      }
      await http()
        .post('/api/test-auth/echo')
        .set('Cookie', cookie)
        .set('Origin', ORIGIN)
        .send({})
        .expect(201);
    });

    it('lets Bearer requests, safe methods and cookie-less public posts through', async () => {
      const { body, access } = await register();
      await http()
        .post('/api/test-auth/echo')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .set('Origin', 'https://evil.example')
        .send({})
        .expect(201);
      await http()
        .get('/api/auth/me')
        .set('Cookie', `${ACCESS_COOKIE}=${access}`)
        .set('Origin', 'https://evil.example')
        .expect(200);
      await http().post('/api/test-auth/webhook').set('Origin', 'https://evil.example').expect(201);
    });
  });

  describe('rate limiting', () => {
    const attempt = (email: string, ip: string) =>
      fresh('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: 'wrong-password-123' });

    it('limits (IP, email) to 5 per minute and counts other IPs separately', async () => {
      const email = newEmail();
      for (let i = 0; i < 5; i++) await attempt(email, '198.51.100.10').expect(401);
      const blocked = await attempt(email, '198.51.100.10').expect(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      await attempt(email, '198.51.100.11').expect(401); // same email, different real client
      await attempt(newEmail(), '198.51.100.10').expect(401); // same client, different email
    });

    it('limits login attempts per IP across emails', async () => {
      for (let i = 0; i < 8; i++) await attempt(newEmail(), '198.51.100.20').expect(401);
      const blocked = await attempt(newEmail(), '198.51.100.20').expect(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      await attempt(newEmail(), '198.51.100.21').expect(401);
    });

    it('limits registrations per IP', async () => {
      const results: number[] = [];
      for (let i = 0; i < 11; i++) {
        const response = await fresh('/api/auth/register')
          .set('X-Forwarded-For', '198.51.100.30')
          .send({ email: newEmail(), password: PASSWORD, name: 'Ada' });
        results.push(response.status);
      }
      expect(results.slice(0, 10).every((s) => s === 201)).toBe(true);
      expect(results[10]).toBe(429);
    });
  });

  describe('logs', () => {
    it('never contain passwords, access tokens or refresh tokens', async () => {
      const lines: string[] = [];
      // tee the shared pino logger (pino-http, Nest, logEvent) into memory
      const logger = getRootLogger() as unknown as Record<symbol, { write(chunk: string): void }>;
      const streamSym = Object.getOwnPropertySymbols(logger).find(
        (s) => s.description === 'pino.stream',
      )!;
      const stream = logger[streamSym]!;
      logger[streamSym] = {
        write: (chunk: string) => void lines.push(chunk),
      };
      const level = (logger as unknown as { level: string }).level;
      (logger as unknown as { level: string }).level = 'info';

      const secretPassword = 'sup3r-secret-password-xyz';
      const email = newEmail();
      const registered = await fresh('/api/auth/register')
        .send({ email, password: secretPassword, name: 'Ada' })
        .expect(201);
      const refreshToken = cookieValue(cookiesOf(registered)[REFRESH_COOKIE]);
      const login = await fresh('/api/auth/login')
        .send({ email, password: secretPassword })
        .expect(200);
      await fresh('/api/auth/login')
        .send({ email, password: `${secretPassword}!` })
        .expect(401);
      const refreshed = await refreshWith(refreshToken).expect(200);
      await prisma.refreshToken.update({
        where: { tokenHash: hashToken(refreshToken) },
        data: { rotatedAt: new Date(Date.now() - 60_000) },
      });
      await refreshWith(refreshToken).expect(401);
      await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(200);
      logger[streamSym] = stream;
      (logger as unknown as { level: string }).level = level;

      const output = lines.join('');
      expect(output).toContain('auth.refresh_reuse_detected'); // logging was captured at all
      expect(output).toContain('"url":"/api/auth/login"');
      const secrets = [
        secretPassword,
        refreshToken,
        registered.body.accessToken,
        login.body.accessToken,
        refreshed.body.accessToken,
        cookieValue(cookiesOf(refreshed)[REFRESH_COOKIE]),
      ];
      for (const secret of secrets) expect(output).not.toContain(secret);
    });
  });
});
