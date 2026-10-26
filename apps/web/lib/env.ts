// Read lazily, inside functions: values must come from the runtime environment, never from the build.

export function apiInternalUrl(): string {
  return (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
}

export function webOrigin(): string {
  return (process.env.WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, '');
}

export function jwtAccessSecret(): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET is not set');
  return secret;
}

/** Shared with the api worker, which sends it in `x-revalidate-secret` when it asks for a page to be rebuilt. */
export function revalidateSecret(): string {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) throw new Error('REVALIDATE_SECRET is not set');
  return secret;
}
