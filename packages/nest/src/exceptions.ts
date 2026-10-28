import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Response } from 'express';
import { type Observable, throwError } from 'rxjs';
import {
  type ApiErrorBody,
  ERROR_CODES,
  ERROR_STATUS,
  type ErrorCode,
  type ValidationIssue,
} from '@collab-docs/shared';
import { getCorrelationId, runWithCorrelationId } from './correlation';
import { InjectPinoLogger, PinoLogger } from './logger';

/** Throw this from application code to return a specific catalog code. */
export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** Extra response headers (e.g. `Retry-After`). */
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number; details?: unknown; headers?: Record<string, string> } = {},
  ) {
    super({ code, message, details: options.details }, options.status ?? ERROR_STATUS[code]);
    this.code = code;
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}

export class ValidationFailedException extends AppException {
  constructor(issues: ValidationIssue[]) {
    super('VALIDATION_FAILED', 'Request validation failed', { details: issues });
  }
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

const GENERIC_MESSAGES: Partial<Record<ErrorCode, string>> = {
  BAD_REQUEST: 'Bad request',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Resource not found',
  CONFLICT: 'Conflict',
  RATE_LIMITED: 'Too many requests',
  PAYLOAD_TOO_LARGE: 'Request body too large',
  SERVICE_UNAVAILABLE: 'Service unavailable',
  INTERNAL_ERROR: 'Internal server error',
};

interface Mapped {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

function internal(): Mapped {
  return { status: 500, code: 'INTERNAL_ERROR', message: GENERIC_MESSAGES.INTERNAL_ERROR! };
}

function fromStatus(status: number, message?: string, details?: unknown): Mapped {
  const code = STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
  return {
    status,
    code,
    // 5xx messages are never forwarded: they may describe internals
    message: (status < 500 && message) || GENERIC_MESSAGES[code] || 'Request failed',
    details,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mapHttpException(exception: HttpException): Mapped {
  if (exception instanceof AppException) {
    const status = exception.getStatus();
    return {
      status,
      code: exception.code,
      message:
        status >= 500 ? (GENERIC_MESSAGES[exception.code] ?? exception.message) : exception.message,
      details: exception.details,
    };
  }
  const body = exception.getResponse();
  const message =
    typeof body === 'string'
      ? body
      : isRecord(body) && typeof body.message === 'string'
        ? body.message
        : undefined;
  return fromStatus(exception.getStatus(), message);
}

/** Errors raised by Express middleware (body-parser) carry `status` and `type` but are not HttpExceptions. */
function mapHttpLikeError(error: Record<string, unknown>): Mapped | undefined {
  const status = typeof error.status === 'number' ? error.status : error.statusCode;
  if (typeof status !== 'number' || status < 400 || status > 499) return undefined;
  if (error.type === 'entity.too.large') return fromStatus(413);
  if (error.type === 'entity.parse.failed') return fromStatus(400, 'Malformed request body');
  return fromStatus(status);
}

function mapPrismaError(error: Record<string, unknown>): Mapped | undefined {
  if (error.name !== 'PrismaClientKnownRequestError') return undefined;
  const meta = isRecord(error.meta) ? error.meta : {};
  switch (error.code) {
    case 'P2002':
      return {
        status: 409,
        code: 'CONFLICT',
        message: 'Resource already exists',
        details: Array.isArray(meta.target) ? { fields: meta.target } : undefined,
      };
    case 'P2025':
      return { status: 404, code: 'NOT_FOUND', message: 'Resource not found' };
    default:
      return undefined;
  }
}

export function mapException(exception: unknown): Mapped {
  if (exception instanceof HttpException) return mapHttpException(exception);
  if (isRecord(exception)) {
    return mapPrismaError(exception) ?? mapHttpLikeError(exception) ?? internal();
  }
  return internal();
}

export function toErrorResponse(exception: unknown, correlationId: string): ApiErrorBody {
  const { status, code, message, details } = mapException(exception);
  return {
    statusCode: status,
    code,
    message,
    ...(details === undefined ? {} : { details }),
    correlationId,
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger(AllExceptionsFilter.name) private readonly logger: PinoLogger) {}

  /**
   * HTTP: writes the error body. RPC (the collab internal API): answers with the same body as an error, so the
   * caller can tell a 404 from a 500. Other contexts are left to Nest's defaults.
   */
  catch(exception: unknown, host: ArgumentsHost): Observable<never> | void {
    const type = host.getType();
    if (type !== 'http' && type !== 'rpc') throw exception;
    // an RPC message cannot carry headers, so its correlation id travels in the payload
    const payload =
      type === 'rpc' ? host.switchToRpc().getData<{ correlationId?: unknown }>() : null;
    const fromPayload =
      typeof payload?.correlationId === 'string' ? payload.correlationId : undefined;
    const correlationId = getCorrelationId() ?? fromPayload ?? 'unknown';
    const body = toErrorResponse(exception, correlationId);

    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const log = () =>
        this.logger.error(
          { err: exception, statusCode: body.statusCode, code: body.code },
          'request failed',
        );
      if (fromPayload && !getCorrelationId()) runWithCorrelationId(fromPayload, log);
      else log();
    }
    if (type === 'rpc') return throwError(() => body);

    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    if (exception instanceof AppException) response.set(exception.headers);
    response.status(body.statusCode).json(body);
  }
}

/** The error body as an OpenAPI schema; the filter above produces it for every failed request. */
export class ErrorResponse implements ApiErrorBody {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ enum: ERROR_CODES, description: 'Branch on this, never on `message`.' })
  code!: ErrorCode;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({
    description:
      'For `VALIDATION_FAILED`: one entry per invalid field. Other codes may add an object.',
    oneOf: [
      {
        type: 'array',
        items: {
          type: 'object',
          required: ['field', 'messages'],
          properties: {
            field: { type: 'string' },
            messages: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      { type: 'object', additionalProperties: true },
    ],
  })
  details?: unknown;

  @ApiProperty({ description: 'The same id is returned in the `x-correlation-id` header.' })
  correlationId!: string;
}
