import {
  type ErrorCode,
  type ValidationIssue,
  apiErrorSchema,
  validationIssueSchema,
} from '@collab-docs/shared';
import { z } from 'zod';

/** Error raised by every API client; carries the machine-readable code and the correlation id for support. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE',
    message: string,
    readonly correlationId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages of a `VALIDATION_FAILED` response, keyed by field name. */
  get fieldErrors(): Record<string, string[]> {
    const parsed = z.array(validationIssueSchema).safeParse(this.details);
    if (!parsed.success) return {};
    return Object.fromEntries(
      parsed.data.map((issue: ValidationIssue) => [issue.field, issue.messages]),
    );
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Turns a non-2xx response into an `ApiError`, tolerating bodies that are not the platform error format. */
export async function toApiError(response: Response): Promise<ApiError> {
  const correlationId = response.headers.get('x-correlation-id') ?? undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    return new ApiError(
      response.status,
      parsed.data.code,
      parsed.data.message,
      parsed.data.correlationId,
      parsed.data.details,
    );
  }
  return new ApiError(
    response.status,
    response.status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
    response.statusText || 'Request failed',
    correlationId,
  );
}

/** Parses a JSON body with `schema`; a mismatch is an `ApiError` rather than an untyped value leaking through. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, correlationId?: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      502,
      'INVALID_RESPONSE',
      'Unexpected response from the server',
      correlationId,
    );
  }
  return parsed.data;
}
