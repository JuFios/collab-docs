import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runWithCorrelationId } from './correlation';
import { createRootLogger } from './logger';

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
