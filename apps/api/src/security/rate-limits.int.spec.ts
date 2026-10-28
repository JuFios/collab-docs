import '../test/env/rate-limits';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { RATE_LIMIT_PRESET } from '@collab-docs/nest';
import { createTestApp } from '../test/test-app';

const PASSWORD = 'correct-horse-battery';
const UNKNOWN_ID = '0198d6c0-0000-7000-8000-000000000000';
const UNKNOWN_TOKEN = 'A'.repeat(43);
const LIMIT = 3;

/** The routes that carry a preset of their own, and which one. Everything else falls under the global per-IP limit. */
const PRESETS: Record<string, string> = {
  'POST /api/auth/register': 'register',
  'POST /api/auth/login': 'login',
  'POST /api/public/links/{token}/ticket': 'guestTicket',
  'POST /api/documents/{id}/collab-ticket': 'ticket',
  'POST /api/documents/{id}/public-links': 'publicLink',
  'GET /api/workspaces/{workspaceId}/search': 'search',
  'POST /api/documents/{id}/threads': 'comment',
  'POST /api/threads/{threadId}/comments': 'comment',
  'PATCH /api/comments/{commentId}': 'comment',
};

/**
 * Routes the global limit does not apply to: one long-lived stream per tab, which has nothing to count, and the
 * operational endpoints, which probes and Prometheus poll and which no published port reaches (they are mounted
 * outside the `/api` prefix; the discovery below does not know that, hence the prefix in their names).
 */
const UNTHROTTLED = new Set([
  'GET /api/events/stream',
  'GET /api/health',
  'GET /api/ready',
  'GET /api/metrics',
]);

const normalise = (path: string) =>
  path
    .replace(/\/+/g, '/')
    .replace(/:(\w+)/g, '{$1}')
    .replace(/\/$/, '');

interface Discovered {
  route: string;
  preset: string | undefined;
  skipped: boolean;
}

function discoverRoutes(app: NestExpressApplication): Discovered[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const found: Discovered[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const base = Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined;
    const prototype = Object.getPrototypeOf(instance) as object;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name] as object;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const own = Reflect.getMetadata(PATH_METADATA, handler) as string | string[];
      const path = normalise(`/api/${[base].flat()[0] ?? ''}/${[own].flat()[0] ?? ''}`);
      const verb = RequestMethod[method];
      const skipKey = 'THROTTLER:SKIPdefault';
      found.push({
        route: `${verb} ${path}`,
        preset:
          (Reflect.getMetadata(RATE_LIMIT_PRESET, handler) as string | undefined) ??
          (Reflect.getMetadata(RATE_LIMIT_PRESET, metatype) as string | undefined),
        skipped:
          Reflect.getMetadata(skipKey, handler) === true ||
          Reflect.getMetadata(skipKey, metatype) === true,
      });
    }
  }
  return found.sort((a, b) => a.route.localeCompare(b.route));
}

describe('rate limits', () => {
  let app: NestExpressApplication;
  let counter = 0;
  let owner: { token: string };
  let other: { token: string };

  /** A request from an address of its own (`ip`), or from a fresh one. */
  const send = (method: 'get' | 'post' | 'patch', path: string, ip?: string, token?: string) => {
    counter += 1;
    const agent = request(app.getHttpServer());
    const req = agent[method](path).set(
      'X-Forwarded-For',
      ip ?? `10.8.${counter % 250}.${(counter >> 8) % 250}`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const register = async (label: string) => {
    const response = await send('post', '/api/auth/register').send({
      email: `${label}-${Date.now()}-${counter}@rate-test.example`,
      password: PASSWORD,
      name: label,
    });
    expect(response.status).toBe(201);
    return { token: response.body.accessToken as string };
  };

  beforeAll(async () => {
    const flush = new Redis(process.env.REDIS_URL as string);
    await flush.flushdb();
    flush.disconnect();
    app = await createTestApp([]);
    owner = await register('owner');
    other = await register('other');
  });

  afterAll(async () => {
    await app.close();
  });

  /** Sends until the limit is spent and returns the first refusal. */
  async function exhaust(attempt: () => request.Test) {
    for (let allowed = 0; allowed < LIMIT; allowed += 1) {
      expect((await attempt()).status).not.toBe(429);
    }
    return attempt();
  }

  function expectRefusal(response: request.Response, windowSeconds: number) {
    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(response.body.correlationId).toEqual(expect.any(String));
    const retryAfter = Number(response.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
  }

  describe('which routes are limited', () => {
    it('gives the sensitive routes a preset of their own, and no other route one', () => {
      const routes = discoverRoutes(app);
      const withPreset = Object.fromEntries(
        routes.filter((r) => r.preset).map((r) => [r.route, r.preset]),
      );
      expect(withPreset).toEqual(PRESETS);
    });

    it('puts every other route under the global per-address limit, except the stream and the operational endpoints', () => {
      const routes = discoverRoutes(app);
      expect(routes.length).toBeGreaterThan(60);
      const skipped = routes.filter((r) => r.skipped).map((r) => r.route);
      expect(new Set(skipped)).toEqual(UNTHROTTLED);
    });
  });

  describe('per client address', () => {
    it('refuses a fourth registration from one address and not from another', async () => {
      const ip = '203.0.113.10';
      const refused = await exhaust(() => send('post', '/api/auth/register', ip).send({}));
      expectRefusal(refused, 3600);
      expect((await send('post', '/api/auth/register', '203.0.113.11').send({})).status).toBe(400);
    });

    it('refuses sign-in attempts, whatever the account', async () => {
      const ip = '203.0.113.20';
      const refused = await exhaust(() =>
        send('post', '/api/auth/login', ip).send({
          email: `nobody-${counter}@rate-test.example`,
          password: PASSWORD,
        }),
      );
      expectRefusal(refused, 60);
    });

    it('refuses guesses of an edit-link token', async () => {
      const ip = '203.0.113.30';
      const refused = await exhaust(() =>
        send('post', `/api/public/links/${UNKNOWN_TOKEN}/ticket`, ip),
      );
      expectRefusal(refused, 60);
    });

    it('limits everything else per address as well', async () => {
      const ip = '203.0.113.40';
      let refused: request.Response | undefined;
      for (let i = 0; i < 40 && !refused; i += 1) {
        const response = await send('get', `/api/invites/${UNKNOWN_TOKEN}`, ip);
        if (response.status === 429) refused = response;
      }
      expect(refused).toBeDefined();
      expectRefusal(refused!, 60);
    });
  });

  describe('per signed-in user', () => {
    const cases: Array<[string, 'get' | 'post', string, number]> = [
      ['collab tickets', 'post', `/api/documents/${UNKNOWN_ID}/collab-ticket`, 60],
      ['public links', 'post', `/api/documents/${UNKNOWN_ID}/public-links`, 3600],
      ['searches', 'get', `/api/workspaces/${UNKNOWN_ID}/search?q=anything`, 60],
      ['comments', 'post', `/api/documents/${UNKNOWN_ID}/threads`, 60],
    ];

    it.each(cases)(
      'refuses too many %s, and counts them per user, not per address',
      async (_n, method, path, window) => {
        const shared = `198.51.100.${(counter % 200) + 1}`;
        const refused = await exhaust(() => send(method, path, shared, owner.token));
        expectRefusal(refused, window);
        // somebody else behind the same address is not punished for it
        const neighbour = await send(method, path, shared, other.token);
        expect(neighbour.status).not.toBe(429);
      },
    );
  });
});
