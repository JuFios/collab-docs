import { type AuthSession, authSessionSchema } from '@collab-docs/shared';
import type { z } from 'zod';
import { ApiError } from './errors';
import { readJson, safeFetch } from './fetch-json';

export interface ClientRequestInit<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  /** Called once when the session cannot be renewed (refresh failed). */
  onSessionLost?: () => void;
}

export interface ApiClient {
  request<T = void>(path: string, init?: ClientRequestInit<T>): Promise<T>;
  /** Single-flight session refresh; concurrent callers share one network request. */
  refresh(): Promise<AuthSession>;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let inflight: Promise<AuthSession> | undefined;

  async function send(path: string, init: ClientRequestInit<unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-correlation-id': crypto.randomUUID(),
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return safeFetch(
      `/api${path}`,
      {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        credentials: 'same-origin',
        signal: init.signal,
      },
      doFetch,
    );
  }

  function refresh(): Promise<AuthSession> {
    inflight ??= (async () => {
      try {
        const response = await send('/auth/refresh', { method: 'POST' });
        return await readJson(response, authSessionSchema);
      } finally {
        // let the next expiry start a fresh refresh once this one settled
        queueMicrotask(() => {
          inflight = undefined;
        });
      }
    })();
    return inflight;
  }

  async function request<T>(path: string, init: ClientRequestInit<T> = {}): Promise<T> {
    let response = await send(path, init);
    if (response.status === 401 && !path.startsWith('/auth/')) {
      try {
        await refresh();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) options.onSessionLost?.();
        throw error;
      }
      response = await send(path, init); // exactly one retry
      if (response.status === 401) {
        options.onSessionLost?.();
      }
    }
    return readJson(response, init.schema);
  }

  return { request, refresh };
}

function redirectToLogin(): void {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

/** Browser singleton used by TanStack Query hooks. */
export const apiClient: ApiClient = createApiClient({ onSessionLost: redirectToLogin });
