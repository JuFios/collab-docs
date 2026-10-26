import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { AppConfig } from './config';
import { correlationMiddleware } from './correlation';
import { AllExceptionsFilter } from './exceptions';
import { MetricsService } from './metrics';
import { createValidationPipe } from './validation';

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

export function corsOrigins(config: AppConfig): string[] {
  return [...new Set([config.WEB_ORIGIN, ...splitList(config.CORS_ALLOWED_ORIGINS)])];
}

/**
 * HTTP pipeline shared by api and collab. Order matters: correlation id and metrics wrap everything,
 * so even rejected requests (CORS, 413, 429) are traced and counted.
 */
export function configureHttpApp(app: NestExpressApplication, config: AppConfig): void {
  app.useLogger(app.get(Logger));
  app.set('trust proxy', parseTrustProxy(config.TRUSTED_PROXY_CIDRS));
  app.use(correlationMiddleware);
  app.use(app.get(MetricsService).httpMiddleware());
  app.use(helmet());
  app.enableCors({ origin: corsOrigins(config), credentials: true });
  app.use(cookieParser());
  app.useBodyParser('json', { limit: config.HTTP_BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: config.HTTP_BODY_LIMIT, extended: true });
  app.setGlobalPrefix('api', { exclude: UNPREFIXED_ROUTES });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}
