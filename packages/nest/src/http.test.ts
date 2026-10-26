import { describe, expect, it } from 'vitest';
import { parseConfig } from './config';
import { corsOrigins, parseTrustProxy } from './http';

describe('http config helpers', () => {
  it('trusts no proxy unless CIDRs are configured', () => {
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy(' 10.0.0.0/8, 172.16.0.0/12 ')).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });

  it('always allows WEB_ORIGIN and adds the configured extras', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      REDIS_URL: 'redis://localhost',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'bucket',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'a-long-enough-secret',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      SMTP_FROM: 'noreply@example.test',
      JWT_ACCESS_SECRET: 'a-long-enough-secret',
      COLLAB_TICKET_SECRET: 'a-long-enough-secret',
      INTERNAL_API_TOKEN: 'a-long-enough-secret',
      REVALIDATE_SECRET: 'a-long-enough-secret',
      WEBHOOK_SIGNING_SECRET: 'a-long-enough-secret',
      WEB_ORIGIN: 'https://app.example.test',
      WEB_INTERNAL_URL: 'http://web:3000',
      API_INTERNAL_URL: 'http://api:4000',
      COLLAB_INTERNAL_URL: 'tcp://collab:4002',
      COLLAB_PUBLIC_URL: 'wss://collab.example.test',
    };
    const config = parseConfig({
      ...base,
      CORS_ALLOWED_ORIGINS: 'https://a.example.test, https://app.example.test',
    });
    expect(corsOrigins(config)).toEqual(['https://app.example.test', 'https://a.example.test']);
  });
});
