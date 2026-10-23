import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { apiErrorSchema, healthResponseSchema, readyResponseSchema } from '@collab-docs/shared';
import { createTestApp } from './test/test-app';

describe('api platform', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const redis = new Redis(process.env.REDIS_URL as string);
    await redis.flushdb();
    redis.disconnect();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('probes and prefix', () => {
    it('serves /health, /ready and /metrics without the /api prefix', async () => {
      const health = await http().get('/health').expect(200);
      expect(healthResponseSchema.parse(health.body)).toEqual({ status: 'ok' });

      const ready = await http().get('/ready').expect(200);
      expect(readyResponseSchema.parse(ready.body)).toEqual({
        status: 'ok',
        checks: { redis: 'up', postgres: 'up' },
      });

      const metrics = await http().get('/metrics').expect(200);
      expect(metrics.headers['content-type']).toContain('text/plain');
      expect(metrics.text).toContain('process_cpu_user_seconds_total');
    });

    it('prefixes application routes with /api', async () => {
      await http().get('/api/test/ok').expect(200).expect({ ok: true });
      const response = await http().get('/test/ok').expect(404);
      expect(apiErrorSchema.parse(response.body)).toMatchObject({
        code: 'NOT_FOUND',
        statusCode: 404,
      });
    });

    it('records request duration by route pattern, method and status', async () => {
      const id = '0190b1c2-0000-7000-8000-000000000001';
      await http().get(`/api/test/items/${id}`).expect(200);
      const { text } = await http().get('/metrics').expect(200);
      expect(text).toMatch(
        /http_request_duration_seconds_count\{route="\/api\/test\/items\/:id",method="GET",status="200"\} 1/,
      );
      expect(text).not.toContain(id);
    });

    it('serves Swagger UI and the OpenAPI document', async () => {
      await http().get('/docs').redirects(1).expect(200);
      const { body } = await http().get('/docs/json').expect(200);
      expect(body.openapi).toMatch(/^3\./);
      expect(Object.keys(body.paths)).toEqual(expect.arrayContaining(['/health', '/ready']));
      expect(body.components.securitySchemes).toHaveProperty('bearer');
    });
  });

  describe('correlation id', () => {
    it('echoes a valid incoming id and exposes it to handlers', async () => {
      const response = await http()
        .get('/api/test/correlation')
        .set('x-correlation-id', 'req-1234-abcd')
        .expect(200);
      expect(response.headers['x-correlation-id']).toBe('req-1234-abcd');
      expect(response.body).toEqual({ correlationId: 'req-1234-abcd' });
    });

    it('generates an id when missing or unsafe', async () => {
      const missing = await http().get('/api/test/ok').expect(200);
      expect(missing.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
      const unsafe = await http()
        .get('/api/test/ok')
        .set('x-correlation-id', 'bad id\twith spaces')
        .expect(200);
      expect(unsafe.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('is part of every error body', async () => {
      const response = await http()
        .get('/api/test/forbidden')
        .set('x-correlation-id', 'err-corr-0001')
        .expect(403);
      expect(apiErrorSchema.parse(response.body)).toEqual({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Not allowed here',
        correlationId: 'err-corr-0001',
      });
    });
  });

  describe('errors and validation', () => {
    it('rejects unknown properties and bad values with VALIDATION_FAILED', async () => {
      const response = await http()
        .post('/api/test/things')
        .send({ name: '', extra: 1 })
        .expect(400);
      const body = apiErrorSchema.parse(response.body);
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(body.details)).toContain('extra');
    });

    it('accepts a valid body', async () => {
      await http().post('/api/test/things').send({ name: 'ok' }).expect(201).expect({ name: 'ok' });
    });

    it('rejects a malformed UUID path parameter', async () => {
      const response = await http().get('/api/test/items/not-a-uuid').expect(400);
      expect(apiErrorSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
    });

    it('validates pagination query parameters', async () => {
      await http().get('/api/test/page').expect(200).expect({ page: 1, pageSize: 20 });
      await http()
        .get('/api/test/page?page=2&pageSize=50')
        .expect(200)
        .expect({ page: 2, pageSize: 50 });
      const response = await http().get('/api/test/page?pageSize=1000').expect(400);
      expect(apiErrorSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
    });

    it('does not leak internals on unexpected errors', async () => {
      const response = await http().get('/api/test/boom').expect(500);
      expect(apiErrorSchema.parse(response.body)).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(response.text).not.toContain('hunter2');
      expect(response.text).not.toContain('db-internal');
    });

    it('answers 413 for bodies over the limit and 400 for malformed JSON', async () => {
      const large = await http()
        .post('/api/test/things')
        .send({ name: 'x'.repeat(20_000) })
        .expect(413);
      expect(apiErrorSchema.parse(large.body).code).toBe('PAYLOAD_TOO_LARGE');
      const malformed = await http()
        .post('/api/test/things')
        .set('content-type', 'application/json')
        .send('{"name":')
        .expect(400);
      expect(apiErrorSchema.parse(malformed.body).code).toBe('BAD_REQUEST');
    });
  });

  describe('http hardening', () => {
    it('sets security headers', async () => {
      const response = await http().get('/api/test/ok').expect(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('allows only configured CORS origins', async () => {
      const allowed = await http()
        .get('/api/test/ok')
        .set('origin', 'http://localhost:3000')
        .expect(200);
      expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      const denied = await http()
        .get('/api/test/ok')
        .set('origin', 'http://evil.example')
        .expect(200);
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('rate limiting', () => {
    it('answers 429 RATE_LIMITED after the preset limit, keyed by the real client IP', async () => {
      const send = (ip: string) => http().get('/api/test/login-limited').set('x-forwarded-for', ip);
      for (let i = 0; i < 3; i += 1) await send('203.0.113.7').expect(200);
      const limited = await send('203.0.113.7').expect(429);
      expect(apiErrorSchema.parse(limited.body)).toMatchObject({
        code: 'RATE_LIMITED',
        statusCode: 429,
      });
      expect(limited.headers['retry-after']).toBeDefined();
      // another client behind the same proxy has its own counter
      await send('203.0.113.8').expect(200);
    });
  });
});
