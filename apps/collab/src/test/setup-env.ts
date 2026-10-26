// Test defaults mirroring the dev-only values of docker-compose.yml; CI and local shells may override them.
// Redis database 9 keeps the suites away from a running dev stack (and from the api suites, which use 10-15).
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
redisUrl.pathname = '/9';

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
  COLLAB_INTERNAL_URL: 'tcp://localhost:4002',
  COLLAB_PUBLIC_URL: 'ws://localhost:4001',
  // short intervals so that the timer-driven behaviour can be observed in a test
  COLLAB_FLUSH_INTERVAL_MS: '60',
  COLLAB_FLUSH_MAX_WAIT_MS: '300',
  COLLAB_COMPACT_MAX_ROWS: '6',
  AUTO_VERSION_INTERVAL_MS: '700',
  COLLAB_ACCESS_RECHECK_MS: '400',
  COLLAB_ROOM_IDLE_MS: '300',
  COLLAB_MAX_CONNECTIONS_PER_DOCUMENT: '4',
};

for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
process.env.REDIS_URL = redisUrl.toString();
