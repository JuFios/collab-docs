import { SignJWT, jwtVerify } from 'jose';
import {
  COLLAB_TICKET_AUDIENCE,
  COLLAB_TICKET_TTL_SECONDS,
  type CollabTicketClaims,
} from '@collab-docs/shared';

const ISSUER = 'collab-docs-api';

const key = (secret: string): Uint8Array => new TextEncoder().encode(secret);

/** Short-lived (60 s) HS256 token that lets one browser open one document's WebSocket. */
export async function signCollabTicket(
  secret: string,
  claims: CollabTicketClaims,
  now: Date = new Date(),
): Promise<string> {
  const jwt = new SignJWT({
    docId: claims.docId,
    ...(claims.linkId ? { linkId: claims.linkId } : {}),
    ...(claims.correlationId ? { cid: claims.correlationId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(COLLAB_TICKET_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(Math.floor(now.getTime() / 1000) + COLLAB_TICKET_TTL_SECONDS);
  if (claims.sub) jwt.setSubject(claims.sub);
  return jwt.sign(key(secret));
}

/** Throws when the signature, audience or expiry is wrong or when the claims are incomplete. */
export async function verifyCollabTicket(
  secret: string,
  token: string,
): Promise<CollabTicketClaims> {
  const { payload } = await jwtVerify(token, key(secret), {
    algorithms: ['HS256'],
    audience: COLLAB_TICKET_AUDIENCE,
    issuer: ISSUER,
  });
  const { docId, linkId, cid, sub } = payload as Record<string, unknown>;
  if (typeof docId !== 'string') throw new Error('ticket has no document');
  if (typeof sub !== 'string' && typeof linkId !== 'string') {
    throw new Error('ticket has neither a user nor a link');
  }
  return {
    docId,
    ...(typeof sub === 'string' ? { sub } : {}),
    ...(typeof linkId === 'string' ? { linkId } : {}),
    ...(typeof cid === 'string' ? { correlationId: cid } : {}),
  };
}
