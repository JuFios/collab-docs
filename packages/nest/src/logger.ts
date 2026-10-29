import { type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InjectPinoLogger,
  Logger as PinoAppLogger,
  LoggerModule,
  PinoLogger,
  getLoggerToken,
} from 'nestjs-pino';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from './config';
import { getCorrelationId } from './correlation';

/** Re-exported so apps need no direct nestjs-pino dependency: `PinoAppLogger` is `app.useLogger()`'s target. */
export { InjectPinoLogger, PinoAppLogger, PinoLogger, getLoggerToken };

/** Field names that hold a credential, wherever they appear in a logged object. */
const SECRET_FIELDS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'ticket',
  'secret',
  'authorization',
  'cookie',
] as const;

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-revalidate-secret"]',
  'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
  // `*.name` reaches one level down (`user.password`); pino needs `name` itself for the fields of the line
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((name) => `*.${name}`),
];

/** Routes whose path carries a capability secret (an invite or edit-link token) right after this prefix. */
const SECRET_PATH = /^(\/api\/(?:invites|public\/links)\/)[^/]+/;

/**
 * The request URL as it may be logged: the secret segment of an invite or edit-link route is masked, and the query
 * string is dropped (it can hold a `next` path with such a token, or search text).
 */
export function loggableUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const path = url.split(/[?#]/, 1)[0] ?? '';
  return path.replace(SECRET_PATH, '$1[REDACTED]');
}

interface SerializedRequest {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: unknown;
  remoteAddress?: string;
  remotePort?: number;
}

/** The request as the request log writes it. */
export function loggableRequest(req: SerializedRequest): SerializedRequest {
  const { id, method, url, headers, remoteAddress, remotePort } = req;
  return { id, method, url: loggableUrl(url), headers, remoteAddress, remotePort };
}

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
          // pino-http hands over its serialised request; `query` and `params` are left out, as they repeat the URL
          serializers: { req: loggableRequest },
        },
      };
    },
  });
