import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;
const storage = new AsyncLocalStorage<{ correlationId: string }>();

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** Accepts a client-supplied id only if it is a short, log-safe token; otherwise issues a new one. */
export function resolveCorrelationId(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && SAFE_ID.test(value) ? value : randomUUID();
}

declare module 'http' {
  interface IncomingMessage {
    correlationId?: string;
  }
}

/** Binds the request's correlation id to AsyncLocalStorage and echoes it in the response. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
  req.correlationId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  runWithCorrelationId(correlationId, next);
}
