import { randomBytes } from 'node:crypto';
import { hashToken } from '../auth/refresh-token.service';

/** Opaque 256-bit EDIT-link token; only its SHA-256 is stored (`public_links.token_hash`). */
export function newLinkToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export { hashToken };
