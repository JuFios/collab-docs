import { signAccessToken } from '@collab-docs/shared';
import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { config, middleware } from './middleware';

const SECRET = 'test-secret-test-secret-test-secret-1234';
const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });

describe('middleware', () => {
  beforeAll(() => {
    // read at request time, as in the deployed container
    process.env.JWT_ACCESS_SECRET = SECRET;
  });

  it('sends anonymous users through the api refresh endpoint and stamps a correlation id', async () => {
    const response = await middleware(request('/w'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/api/auth/refresh?next=%2Fw',
    );
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses an incoming correlation id', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3000/', { headers: { 'x-correlation-id': 'abc' } }),
    );
    expect(response.headers.get('x-correlation-id')).toBe('abc');
  });

  it('asks browsers to stay on HTTPS in staging only', async () => {
    const original = process.env.APP_ENV;
    try {
      process.env.APP_ENV = 'staging';
      const staging = await middleware(request('/login'));
      expect(staging.headers.get('strict-transport-security')).toBe(
        'max-age=31536000; includeSubDomains',
      );
      process.env.APP_ENV = 'dev';
      expect(
        (await middleware(request('/login'))).headers.get('strict-transport-security'),
      ).toBeNull();
    } finally {
      if (original === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = original;
    }
  });

  it('passes valid sessions through', async () => {
    const { token } = await signAccessToken(SECRET, '3f2b1c0e-8f0a-4b8e-9a53-7a1d2f3c4b5d');
    const response = await middleware(request('/w', `cd_at=${token}`));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('remembers the workspace being viewed and does not rewrite an unchanged cookie', async () => {
    const { token } = await signAccessToken(SECRET, '3f2b1c0e-8f0a-4b8e-9a53-7a1d2f3c4b5d');
    const id = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    const first = await middleware(request(`/w/${id}/settings`, `cd_at=${token}`));
    expect(first.cookies.get('cd_ws')).toMatchObject({
      value: id,
      httpOnly: true,
      sameSite: 'lax',
    });

    const again = await middleware(request(`/w/${id}`, `cd_at=${token}; cd_ws=${id}`));
    expect(again.cookies.get('cd_ws')).toBeUndefined();

    const elsewhere = await middleware(request('/w', `cd_at=${token}`));
    expect(elsewhere.cookies.get('cd_ws')).toBeUndefined();
  });

  it('sends expired sessions through the api refresh endpoint', async () => {
    const { token } = await signAccessToken(SECRET, '3f2b1c0e-8f0a-4b8e-9a53-7a1d2f3c4b5d', {
      now: new Date(Date.now() - 3_600_000),
    });
    const response = await middleware(request('/w/abc', `cd_at=${token}`));
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/api/auth/refresh?next=%2Fw%2Fabc',
    );
  });

  it('treats a forged token as anonymous', async () => {
    const { token } = await signAccessToken(
      'another-secret-another-secret-123456',
      '3f2b1c0e-8f0a-4b8e-9a53-7a1d2f3c4b5d',
    );
    const response = await middleware(request('/w', `cd_at=${token}`));
    expect(response.headers.get('location')).toContain('/api/auth/refresh?next=');
  });

  it('excludes the api proxy, internal handlers and assets from the matcher', () => {
    const regex = new RegExp(`^${config.matcher[0]}$`);
    for (const path of [
      '/api/auth/refresh',
      '/internal/revalidate',
      '/_next/static/x.js',
      '/favicon.ico',
      '/logo.png',
      '/media/1',
    ]) {
      expect(regex.test(path)).toBe(false);
    }
    for (const path of ['/', '/w', '/w/1/d/2', '/login', '/p/slug'])
      expect(regex.test(path)).toBe(true);
  });
});
