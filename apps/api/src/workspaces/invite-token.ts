import { randomBytes } from 'node:crypto';
import { hashToken } from '../auth/refresh-token.service';

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

/** Opaque 256-bit invite token; only its SHA-256 is stored (`workspace_invites.token_hash`). */
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export { hashToken };

/** Well-formed tokens are 43 base64url characters; anything else cannot match and skips the lookup. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
