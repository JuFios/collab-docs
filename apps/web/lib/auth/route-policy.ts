import { DEFAULT_NEXT_PATH, sanitizeNextPath } from '@collab-docs/shared';

/** `expired`/`none` are handled alike for routing; the distinction is kept for logging and tests. */
export type SessionState = 'valid' | 'expired' | 'none';

export type RouteDecision =
  | { type: 'next' }
  /** Send the browser through `GET /api/auth/refresh` (the only path that receives the refresh cookie). */
  | { type: 'refresh'; next: string }
  | { type: 'redirect'; location: string };

/** Routes that anyone may open; everything else needs a session. */
const PUBLIC_PREFIXES = ['/published/', '/edit-link/', '/invite/', '/mock-checkout/'];
/** Routes a signed-in user is bounced away from. */
const GUEST_ONLY = ['/login', '/register'];

export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    GUEST_ONLY.includes(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
  );
}

export interface RouteInput {
  pathname: string;
  search: string;
  session: SessionState;
}

/**
 * Pure routing decision of the edge middleware. This is UX, not security: every request is authorized again
 * by the api.
 */
export function decideRoute({ pathname, search, session }: RouteInput): RouteDecision {
  const guestOnly = GUEST_ONLY.includes(pathname);

  if (guestOnly) {
    if (session === 'valid') {
      const next = sanitizeNextPath(new URLSearchParams(search).get('next'), DEFAULT_NEXT_PATH);
      return { type: 'redirect', location: next };
    }
    return { type: 'next' };
  }

  if (isPublicPath(pathname)) return { type: 'next' };

  if (session === 'valid') return { type: 'next' };
  const target = sanitizeNextPath(`${pathname}${search}`, DEFAULT_NEXT_PATH);
  // No usable access token. The cookie lives exactly as long as the JWT, so an expired session usually shows
  // up as a missing cookie, and the refresh cookie is invisible here (Path=/api/auth). Let the api decide: it
  // renews the session, or answers with a redirect to /login?next=…
  return { type: 'refresh', next: target };
}
