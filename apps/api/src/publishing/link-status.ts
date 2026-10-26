import type { PublicLink as PublicLinkRow } from '@collab-docs/db';
import type { PublicLinkStatus } from '@collab-docs/shared';

/** `active` is the only state in which a link grants anything; a revocation outranks an expiry. */
export function statusOf(
  link: Pick<PublicLinkRow, 'revokedAt' | 'expiresAt'>,
  now = new Date(),
): PublicLinkStatus {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}
