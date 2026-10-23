// Test defaults mirroring the dev-only values of docker-compose.yml; CI and local shells may override them.
// Redis database 15 is used so that tests never touch (or flush) keys of a running dev stack.
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
redisUrl.pathname = '/15';

const defaults: Record<string, string> = {
  APP_ENV: 'test',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://collab:dev-only-postgres-password@localhost:5432/collab',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'collab-docs',
  S3_ACCESS_KEY: 'dev-only-minio',
  S3_SECRET_KEY: 'dev-only-minio-secret',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'Collab Docs <noreply@collab-docs.local>',
  JWT_ACCESS_SECRET: 'dev-only-jwt-access-secret-change-me',
  COLLAB_TICKET_SECRET: 'dev-only-collab-ticket-secret-change-me',
  INTERNAL_API_TOKEN: 'dev-only-internal-api-token-change-me',
  REVALIDATE_SECRET: 'dev-only-revalidate-secret-change-me',
  WEBHOOK_SIGNING_SECRET: 'dev-only-webhook-signing-secret-change-me',
  WEB_ORIGIN: 'http://localhost:3000',
  WEB_INTERNAL_URL: 'http://localhost:3000',
  API_INTERNAL_URL: 'http://localhost:4000',
  COLLAB_INTERNAL_URL: 'http://localhost:4002',
  COLLAB_PUBLIC_URL: 'ws://localhost:4001',
  TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
  HTTP_BODY_LIMIT: '10kb',
  RATE_LOGIN_PER_MIN_IP: '3',
};

for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
process.env.REDIS_URL = redisUrl.toString();
