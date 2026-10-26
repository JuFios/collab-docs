import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { AppConfig } from './config';
import { correlationMiddleware } from './correlation';
import { MetricsService } from './metrics';

/** Routes served without the `/api` prefix (probes, scraping, docs). */
export const UNPREFIXED_ROUTES = ['health', 'ready', 'metrics', 'docs', 'docs/{*path}'];

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** `trust proxy` accepts a CIDR list; an empty list means "trust nobody" so XFF cannot be spoofed. */
export function parseTrustProxy(cidrs: string): boolean | string[] {
  const list = splitList(cidrs);
  return list.length > 0 ? list : false;
}

export function corsOrigins(
  config: Pick<AppConfig, 'WEB_ORIGIN' | 'CORS_ALLOWED_ORIGINS'>,
): string[] {
  return [...new Set([config.WEB_ORIGIN, ...splitList(config.CORS_ALLOWED_ORIGINS)])];
}

/**
 * HTTP pipeline shared by api and collab. Order matters: correlation id and metrics wrap everything,
 * so even rejected requests (CORS, 413, 429) are traced and counted.
 */
export function configureHttpApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  app.useLogger(app.get(Logger));
  app.set('trust proxy', parseTrustProxy(config.get('TRUSTED_PROXY_CIDRS', { infer: true })));
  app.use(correlationMiddleware);
  app.use(app.get(MetricsService).httpMiddleware());
  app.use(helmet());
  app.enableCors({
    origin: corsOrigins({
      WEB_ORIGIN: config.get('WEB_ORIGIN', { infer: true }),
      CORS_ALLOWED_ORIGINS: config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
    }),
    credentials: true,
  });
  app.use(cookieParser());
  const bodyLimit = config.get('HTTP_BODY_LIMIT', { infer: true });
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });
  app.setGlobalPrefix('api', { exclude: UNPREFIXED_ROUTES });
  app.enableShutdownHooks();
}
