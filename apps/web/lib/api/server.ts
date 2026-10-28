import { cookies, headers } from 'next/headers';
import type { z } from 'zod';
import { apiInternalUrl, webOrigin } from '../env';
import { readJson, safeFetch } from './fetch-json';

interface ServerRequestInit<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  schema?: z.ZodType<T>;
}

/** Headers every server-side call to the api carries: the user's cookies, client IP and correlation id. */
async function serverHeaders(): Promise<Headers> {
  const [cookieStore, incoming] = await Promise.all([cookies(), headers()]);
  const out = new Headers({
    'x-correlation-id': incoming.get('x-correlation-id') ?? crypto.randomUUID(),
    // the api only trusts this from TRUSTED_PROXY_CIDRS; without it every user shares the web container's rate limit
    origin: webOrigin(),
  });
  const cookie = cookieStore.toString();
  if (cookie) out.set('cookie', cookie);
  const forwarded = incoming.get('x-forwarded-for');
  if (forwarded) out.set('x-forwarded-for', forwarded);
  return out;
}

/** Raw response, for callers that must read `Set-Cookie` (login, logout). */
export async function apiServerRaw(
  path: string,
  init: ServerRequestInit<unknown> = {},
): Promise<Response> {
  const requestHeaders = await serverHeaders();
  if (init.body !== undefined) requestHeaders.set('content-type', 'application/json');
  return safeFetch(`${apiInternalUrl()}/api${path}`, {
    method: init.method ?? 'GET',
    headers: requestHeaders,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
    redirect: 'manual',
  });
}

export async function apiServer<T = void>(
  path: string,
  init: ServerRequestInit<T> = {},
): Promise<T> {
  return readJson(await apiServerRaw(path, init), init.schema);
}
