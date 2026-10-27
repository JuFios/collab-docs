import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './config';

const validEnv: Record<string, string> = {
  DATABASE_URL: 'postgresql://app:pw@localhost:5432/app',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-secret-secret',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'noreply@example.test',
  JWT_ACCESS_SECRET: 'jwt-secret-jwt-secret',
  COLLAB_TICKET_SECRET: 'ticket-secret-ticket',
  INTERNAL_API_TOKEN: 'internal-token-internal',
  METRICS_TOKEN: 'metrics-token-metrics',
  REVALIDATE_SECRET: 'revalidate-secret-1',
  WEBHOOK_SIGNING_SECRET: 'webhook-secret-1234',
  WEB_ORIGIN: 'http://localhost:3000',
  WEB_INTERNAL_URL: 'http://web:3000',
  API_INTERNAL_URL: 'http://api:4000',
  COLLAB_INTERNAL_URL: 'tcp://collab:4002',
  COLLAB_PUBLIC_URL: 'ws://localhost:4001',
};

describe('parseConfig', () => {
  it('applies defaults to a valid environment', () => {
    const config = parseConfig(validEnv);
    expect(config.APP_ENV).toBe('dev');
    expect(config.COLLAB_FLUSH_INTERVAL_MS).toBe(1000);
    expect(config.COLLAB_INTERNAL_PORT).toBe(4002);
  });

  it('reports every problem in one error', () => {
    const rest: Record<string, string> = { ...validEnv };
    delete rest.DATABASE_URL;
    delete rest.JWT_ACCESS_SECRET;
    try {
      parseConfig({ ...rest, SMTP_PORT: 'abc' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).toContain('SMTP_PORT');
    }
  });

  it('treats empty strings as unset', () => {
    expect(parseConfig({ ...validEnv, LOG_LEVEL: '' }).LOG_LEVEL).toBe('info');
  });

  it('rejects development placeholders in staging', () => {
    const env = { ...validEnv, APP_ENV: 'staging', NODE_ENV: 'production' };
    expect(() => parseConfig(env)).not.toThrow();
    expect(() => parseConfig({ ...env, JWT_ACCESS_SECRET: 'dev-only-jwt-access-secret' })).toThrow(
      /JWT_ACCESS_SECRET.*development placeholder/,
    );
  });

  it('requires NODE_ENV=production in staging', () => {
    expect(() => parseConfig({ ...validEnv, APP_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
