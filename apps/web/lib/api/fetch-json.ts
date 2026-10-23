import type { z } from 'zod';
import { ApiError, parseBody, toApiError } from './errors';

/** Shared tail of every client: status check, JSON parsing and zod validation. */
export async function readJson<T>(response: Response, schema?: z.ZodType<T>): Promise<T> {
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204 || !schema) return undefined as T;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      502,
      'INVALID_RESPONSE',
      'Unexpected response from the server',
      response.headers.get('x-correlation-id') ?? undefined,
    );
  }
  return parseBody(schema, body, response.headers.get('x-correlation-id') ?? undefined);
}

export async function safeFetch(
  input: string,
  init: RequestInit,
  doFetch: typeof fetch = (url, options) => fetch(url, options),
): Promise<Response> {
  try {
    return await doFetch(input, init);
  } catch {
    throw new ApiError(503, 'NETWORK_ERROR', 'Cannot reach the server');
  }
}
