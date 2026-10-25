export * from './errors';
export * from './pagination';
export * from './auth';
export * from './workspaces';
export * from './next-path';
export * from './documents';

import { SignJWT, jwtVerify } from 'jose';

/**
 * Round-trips an HS256 token through `jose` (ESM-only). Used by smoke tests to prove that
 * the package and its ESM-only dependency load in every runtime we ship to.
 */
export async function jwtRoundTrip(subject: string): Promise<string | undefined> {
  const secret = new TextEncoder().encode('smoke-test-secret-smoke-test-secret');
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setExpirationTime('1m')
    .sign(secret);
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  return payload.sub;
}
export * from './plans';
export * from './permissions';
export * from './realtime-events';
export * from './fractional';
export * from './collab';
