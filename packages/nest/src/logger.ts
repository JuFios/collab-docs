import { type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, Logger as PinoAppLogger, LoggerModule, PinoLogger } from 'nestjs-pino';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from './config';
import { getCorrelationId } from './correlation';

/** Re-exported so apps need no direct nestjs-pino dependency: `PinoAppLogger` is `app.useLogger()`'s target. */
export { InjectPinoLogger, PinoAppLogger, PinoLogger };

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-revalidate-secret"]',
  'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.authorization',
  '*.cookie',
];

export function createRootLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      mixin: () => {
        const correlationId = getCorrelationId();
        return correlationId ? { correlationId } : {};
      },
    },
    destination,
  );
}

/** Structured business event (`document.published`, `plan.changed`, ...); carries the ambient correlation id. */
export function logEvent(
  logger: PinoLogger,
  name: string,
  fields: Record<string, unknown> = {},
): void {
  logger.info({ ...fields, event: name }, name);
}

const SILENT_PATHS = /^\/(health|ready|metrics)(\/|\?|$)/;

/**
 * Call it where the application module is declared, after the imports of the feature modules: `forRootAsync`
 * registers one provider per `@InjectPinoLogger(context)` seen so far, so classes loaded later would not resolve.
 */
export const platformLoggerModule = (): DynamicModule =>
  LoggerModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService<AppConfig, true>) => {
      return {
        pinoHttp: {
          logger: createRootLogger(config.get('LOG_LEVEL', { infer: true })),
          // lines logged inside a request carry only its id, not the whole serialised request
          quietReqLogger: true,
          genReqId: (req) => req.correlationId ?? getCorrelationId() ?? '',
          customProps: (req) => ({ correlationId: req.id }),
          autoLogging: { ignore: (req) => SILENT_PATHS.test(req.url ?? '') },
        },
      };
    },
  });
