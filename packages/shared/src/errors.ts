import { z } from 'zod';

/** Machine-readable error codes returned in every error response (`code`). */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'CSRF_REJECTED',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PLAN_LIMIT_EXCEEDED',
  'LINK_EXPIRED',
  'DOCUMENT_DELETED',
  'INVITE_INVALID',
  'WEBHOOK_SIGNATURE_INVALID',
  'PAYLOAD_TOO_LARGE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

/** Default HTTP status for each code; used when an exception does not carry its own. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PLAN_LIMIT_EXCEEDED: 403,
  LINK_EXPIRED: 410,
  DOCUMENT_DELETED: 410,
  INVITE_INVALID: 400,
  WEBHOOK_SIGNATURE_INVALID: 401,
  PAYLOAD_TOO_LARGE: 413,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export const validationIssueSchema = z.object({
  field: z.string(),
  messages: z.array(z.string()),
});

/** Error body shared by api and collab HTTP endpoints. */
export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  code: errorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
  correlationId: z.string(),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
export type ValidationIssue = z.infer<typeof validationIssueSchema>;
