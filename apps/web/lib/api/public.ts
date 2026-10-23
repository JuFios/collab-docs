import type { z } from 'zod';
import { apiInternalUrl } from '../env';
import { readJson, safeFetch } from './fetch-json';

export interface PublicRequestInit<T> {
  schema: z.ZodType<T>;
  /** ISR options forwarded to Next's fetch cache. */
  next?: { revalidate?: number | false; tags?: string[] };
}

/**
 * Anonymous api client for statically rendered pages. It must never read `cookies()` or `headers()`:
 * doing so would opt the page out of ISR.
 */
export async function apiPublic<T>(path: string, init: PublicRequestInit<T>): Promise<T> {
  const response = await safeFetch(`${apiInternalUrl()}/api${path}`, {
    headers: { accept: 'application/json' },
    next: init.next,
  });
  return readJson(response, init.schema);
}
