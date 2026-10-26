import { type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoAppLogger, LoggerModule } from 'nestjs-pino';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from './config';
import { getCorrelationId } from './correlation';

/** Nest's `app.useLogger()` target; re-exported so apps need no direct nestjs-pino dependency. */
export { PinoAppLogger };

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

let root: Logger = createRootLogger(process.env.LOG_LEVEL ?? 'info');

export function getRootLogger(): Logger {
  return root;
}

export function setRootLogger(logger: Logger): void {
  root = logger;
}

/** Structured business event (`document.published`, `plan.changed`, ...); carries the ambient correlation id. */
export function logEvent(name: string, fields: Record<string, unknown> = {}): void {
  root.info({ ...fields, event: name }, name);
}

const SILENT_PATHS = /^\/(health|ready|metrics)(\/|\?|$)/;

export const PlatformLoggerModule: DynamicModule = LoggerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfig, true>) => {
    const logger = createRootLogger(config.get('LOG_LEVEL', { infer: true }));
    setRootLogger(logger);
    return {
      pinoHttp: {
        logger,
        genReqId: (req) => req.correlationId ?? getCorrelationId() ?? '',
        customProps: (req) => ({ correlationId: req.id }),
        autoLogging: { ignore: (req) => SILENT_PATHS.test(req.url ?? '') },
      },
    };
  },
});
