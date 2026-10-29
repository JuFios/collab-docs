import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runWithCorrelationId } from './correlation';
import { createRootLogger, loggableRequest, loggableUrl } from './logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)));
      callback();
    },
  });
  return { lines, logger: createRootLogger('info', stream) };
}

describe('root logger', () => {
  it('redacts credentials in request headers and payload fields', () => {
    const { lines, logger } = capture();
    logger.info(
      {
        req: {
          headers: { authorization: 'Bearer abc', cookie: 'cd_at=secret', 'x-ok': 'visible' },
        },
        res: { headers: { 'set-cookie': ['cd_rt=secret'] } },
        user: { email: 'a@example.test', password: 'hunter2', refreshToken: 'rt-secret' },
      },
      'sample',
    );
    const text = JSON.stringify(lines[0]);
    expect(text).not.toMatch(/Bearer abc|cd_at=secret|cd_rt=secret|hunter2|rt-secret/);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('visible');
    expect(text).toContain('a@example.test');
  });

  it('redacts a credential whether it is a field of the line or of an object inside it', () => {
    const { lines, logger } = capture();
    logger.info(
      {
        event: 'sample.event',
        password: 'top-password',
        token: 'top-token',
        ticket: 'top-ticket',
        inner: { secret: 'inner-secret', accessToken: 'inner-access' },
        req: {
          headers: {
            'x-revalidate-secret': 'value-of-the-rv-header',
            'x-internal-token': 'value-of-the-internal-header',
          },
        },
      },
      'sample',
    );
    const text = JSON.stringify(lines[0]);
    for (const leaked of [
      'top-password',
      'top-token',
      'top-ticket',
      'inner-secret',
      'inner-access',
      'value-of-the-rv-header',
      'value-of-the-internal-header',
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(lines[0]).toMatchObject({ event: 'sample.event' });
  });

  it('adds the ambient correlation id to every line', () => {
    const { lines, logger } = capture();
    runWithCorrelationId('corr-log-0001', () => logger.info('inside'));
    logger.info('outside');
    expect(lines[0]).toMatchObject({ correlationId: 'corr-log-0001' });
    expect(lines[1]).not.toHaveProperty('correlationId');
  });
});

describe('loggableUrl', () => {
  it('masks the token of invite and edit-link routes', () => {
    expect(loggableUrl('/api/invites/tok3n')).toBe('/api/invites/[REDACTED]');
    expect(loggableUrl('/api/invites/tok3n/accept')).toBe('/api/invites/[REDACTED]/accept');
    expect(loggableUrl('/api/public/links/tok3n/ticket')).toBe(
      '/api/public/links/[REDACTED]/ticket',
    );
  });

  it('drops the query string and leaves other paths alone', () => {
    expect(loggableUrl('/api/auth/refresh?next=%2Finvite%2Ftok3n')).toBe('/api/auth/refresh');
    expect(loggableUrl('/api/workspaces/w1/invites/i1')).toBe('/api/workspaces/w1/invites/i1');
    expect(loggableUrl('/api/public/documents/my-page')).toBe('/api/public/documents/my-page');
    expect(loggableUrl(undefined)).toBeUndefined();
  });
});

describe('loggableRequest', () => {
  it('keeps what identifies the request and drops the parsed query and route parameters', () => {
    const logged = loggableRequest({
      id: 'r1',
      method: 'GET',
      url: '/api/invites/tok3n?next=%2Fx',
      headers: { host: 'api' },
      remoteAddress: '10.0.0.1',
      remotePort: 1234,
      query: { next: '/x' },
      params: { token: 'tok3n' },
    } as Parameters<typeof loggableRequest>[0]);
    expect(logged).toEqual({
      id: 'r1',
      method: 'GET',
      url: '/api/invites/[REDACTED]',
      headers: { host: 'api' },
      remoteAddress: '10.0.0.1',
      remotePort: 1234,
    });
  });
});
