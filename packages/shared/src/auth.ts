import { SignJWT, errors, jwtVerify } from 'jose';
import { z } from 'zod';

/** Cookie names and lifetimes shared by api (issuer) and web/collab (verifiers). */
export const ACCESS_COOKIE = 'cd_at';
export const REFRESH_COOKIE = 'cd_rt';
export const REFRESH_COOKIE_PATH = '/api/auth';
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const ACCESS_TOKEN_AUDIENCE = 'api';

export const authUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  /** Documents can be shared with the account only once its address is confirmed. */
  emailVerified: z.boolean(),
});

/** Body of login / register / refresh. The refresh token travels only in its httpOnly cookie. */
export const authSessionSchema = z.object({
  user: authUserSchema,
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
});

export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Unique token id. */
  jti: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export type AccessTokenFailure = 'expired' | 'invalid';

export class AccessTokenError extends Error {
  constructor(readonly reason: AccessTokenFailure) {
    super(`access token ${reason}`);
    this.name = 'AccessTokenError';
  }
}

function key(secret: string | Uint8Array): Uint8Array {
  return typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
}

export async function signAccessToken(
  secret: string | Uint8Array,
  userId: string,
  options: { jti?: string; ttlSeconds?: number; now?: Date } = {},
): Promise<{ token: string; jti: string; expiresIn: number }> {
  const jti = options.jti ?? crypto.randomUUID();
  const expiresIn = options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(jti)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresIn)
    .sign(key(secret));
  return { token, jti, expiresIn };
}

/**
 * Verifies an access JWT (HS256, `aud=api`, not expired). Uses only `jose` and Web APIs, so it runs in
 * Next's Edge middleware as well as in Node (api, collab). Throws `AccessTokenError`.
 */
export async function verifyAccessToken(
  token: string,
  secret: string | Uint8Array,
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'],
      audience: ACCESS_TOKEN_AUDIENCE,
    });
    if (!payload.sub || !payload.jti || typeof payload.exp !== 'number') {
      throw new AccessTokenError('invalid');
    }
    return { sub: payload.sub, jti: payload.jti, exp: payload.exp };
  } catch (error) {
    if (error instanceof AccessTokenError) throw error;
    throw new AccessTokenError(error instanceof errors.JWTExpired ? 'expired' : 'invalid');
  }
}

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Trimmed, lower-cased, valid address of at most 254 characters. */
export const emailInput = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address.').max(254, 'Email is too long.'));

/**
 * The domain of the address an account keeps after it gave up its real one to a new registration. `.invalid` never
 * resolves (RFC 2606), so no mail reaches it, and nobody may register it: the placeholder of an account must always
 * be free when the account is released.
 */
export const RELEASED_EMAIL_DOMAIN = 'released.invalid';

export const releasedEmail = (userId: string): string => `${userId}@${RELEASED_EMAIL_DOMAIN}`;

export const isReleasedEmail = (email: string): boolean =>
  email.toLowerCase().endsWith(`@${RELEASED_EMAIL_DOMAIN}`);

export const loginInputSchema = z.object({
  email: emailInput,
  password: z
    .string()
    .min(1, 'Enter your password.')
    .max(PASSWORD_MAX_LENGTH, 'Password is too long.'),
});

export const registerInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(100, 'Name is too long.'),
  email: emailInput.refine((email) => !isReleasedEmail(email), 'This address cannot be used.'),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    .max(PASSWORD_MAX_LENGTH, 'Password is too long.'),
});

export type LoginInput = z.infer<typeof loginInputSchema>;
export type RegisterInput = z.infer<typeof registerInputSchema>;
