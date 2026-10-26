import type { CookieOptions, Request, Response } from 'express';
import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
} from '@collab-docs/shared';
import type { AppConfig } from '@collab-docs/nest';

/** Secure cookies everywhere except local development and tests (plain http). */
export function cookieOptions(
  config: Pick<AppConfig, 'APP_ENV'>,
  path: string,
  maxAgeSeconds: number,
): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.APP_ENV === 'staging',
    path,
    maxAge: maxAgeSeconds * 1000,
  };
}

export function setAccessCookie(
  res: Response,
  config: Pick<AppConfig, 'APP_ENV'>,
  token: string,
): void {
  res.cookie(ACCESS_COOKIE, token, cookieOptions(config, '/', ACCESS_TOKEN_TTL_SECONDS));
}

export function setRefreshCookie(
  res: Response,
  config: Pick<AppConfig, 'APP_ENV'>,
  token: string,
): void {
  res.cookie(
    REFRESH_COOKIE,
    token,
    cookieOptions(config, REFRESH_COOKIE_PATH, REFRESH_TOKEN_TTL_SECONDS),
  );
}

export function clearAuthCookies(res: Response, config: Pick<AppConfig, 'APP_ENV'>): void {
  // attributes (notably Path) must match the ones the cookies were set with; Express ignores maxAge here
  res.clearCookie(ACCESS_COOKIE, cookieOptions(config, '/', 0));
  res.clearCookie(REFRESH_COOKIE, cookieOptions(config, REFRESH_COOKIE_PATH, 0));
}

export function readCookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `Authorization: Bearer <token>` -> token. */
export function readBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}
