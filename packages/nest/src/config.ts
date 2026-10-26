import { z } from 'zod';

/** Marker used by every development-only default; rejected when APP_ENV=staging. */
export const DEV_ONLY_MARKER = 'dev-only';

const url = z.string().url();
const secret = z.string().min(16, 'must be at least 16 characters');
const positiveInt = z.coerce.number().int().positive();

export const envSchema = z.object({
  APP_ENV: z.enum(['dev', 'staging', 'test']).default('dev'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: positiveInt.optional(),
  COLLAB_INTERNAL_PORT: positiveInt.default(4002),

  DATABASE_URL: z.string().min(1).startsWith('postgres'),
  REDIS_URL: z.string().min(1).startsWith('redis'),

  S3_ENDPOINT: url,
  S3_PUBLIC_ENDPOINT: url,
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY: z.string().min(3),
  S3_SECRET_KEY: secret,

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: positiveInt,
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().min(3),

  JWT_ACCESS_SECRET: secret,
  COLLAB_TICKET_SECRET: secret,
  INTERNAL_API_TOKEN: secret,
  REVALIDATE_SECRET: secret,
  WEBHOOK_SIGNING_SECRET: secret,

  WEB_ORIGIN: url,
  WEB_INTERNAL_URL: url,
  API_INTERNAL_URL: url,
  COLLAB_INTERNAL_URL: z.string().regex(/^tcp:\/\/[^/:]+:\d+$/, 'must look like tcp://host:port'),
  COLLAB_PUBLIC_URL: z.string().regex(/^wss?:\/\//, 'must start with ws:// or wss://'),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  /** Comma-separated extra CORS origins; WEB_ORIGIN is always allowed. */
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  HTTP_BODY_LIMIT: z
    .string()
    .regex(/^\d+(kb|mb)$/i, 'e.g. 1mb')
    .default('1mb'),

  // argon2id parameters (defaults follow the OWASP minimum: 19 MiB, 2 iterations, 1 lane)
  ARGON2_MEMORY_KIB: positiveInt.default(19456),
  ARGON2_TIME_COST: positiveInt.default(2),
  ARGON2_PARALLELISM: positiveInt.default(1),

  /** Largest single image accepted by the upload policy (bytes). */
  ATTACHMENT_MAX_BYTES: positiveInt.max(100 * 1024 * 1024).default(10 * 1024 * 1024),
  /** An upload that was never completed is swept after this many hours. */
  ATTACHMENT_PENDING_TTL_HOURS: positiveInt.default(24),

  BILLING_PROVIDER: z.enum(['mock']).default('mock'),

  // CRDT persistence, debounce and version thresholds
  COLLAB_FLUSH_INTERVAL_MS: positiveInt.default(1000),
  COLLAB_FLUSH_MAX_WAIT_MS: positiveInt.default(5000),
  COLLAB_COMPACT_MAX_ROWS: positiveInt.default(100),
  COLLAB_COMPACT_MAX_BYTES: positiveInt.default(512 * 1024),
  AUTO_VERSION_INTERVAL_MS: positiveInt.default(10 * 60 * 1000),
  REVALIDATE_DEBOUNCE_MS: positiveInt.default(3000),
  SEARCH_DEBOUNCE_MS: positiveInt.default(5000),
  ISR_REVALIDATE_SECONDS: positiveInt.default(3600),

  // Rate limits and collab limits
  RATE_GLOBAL_PER_MIN_IP: positiveInt.default(600),
  RATE_TICKET_PER_MIN_USER: positiveInt.default(30),
  RATE_LOGIN_PER_MIN_IP_EMAIL: positiveInt.default(5),
  RATE_LOGIN_PER_MIN_IP: positiveInt.default(20),
  RATE_REGISTER_PER_HOUR_IP: positiveInt.default(10),
  RATE_PUBLIC_LINK_PER_HOUR_USER: positiveInt.default(10),
  COLLAB_MAX_MESSAGES_PER_10S: positiveInt.default(200),
  COLLAB_MAX_UPDATE_BYTES: positiveInt.default(1024 * 1024),
  COLLAB_MAX_DOCUMENT_BYTES: positiveInt.default(10 * 1024 * 1024),
  COLLAB_MAX_CONNECTIONS_PER_DOCUMENT: positiveInt.default(100),
  COLLAB_MAX_AWARENESS_BYTES: positiveInt.default(4096),
  /** An unused room is unloaded after this long without connections. */
  COLLAB_ROOM_IDLE_MS: positiveInt.default(30_000),
  /** Every open socket gets its permissions re-read this often (a safety net for lost Redis events). */
  COLLAB_ACCESS_RECHECK_MS: positiveInt.default(60_000),
});

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Validates the environment; throws ConfigError listing every problem at once. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  // Treat empty strings (e.g. `VAR=` in an env file) as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const config = result.data;

  if (config.APP_ENV === 'staging') {
    const issues: string[] = [];
    if (config.NODE_ENV !== 'production') issues.push('NODE_ENV: must be "production" in staging');
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string' && value.includes(DEV_ONLY_MARKER)) {
        issues.push(`${key}: contains a development placeholder; set a real value for staging`);
      }
    }
    if (issues.length > 0) throw new ConfigError(issues);
  }
  return config;
}
