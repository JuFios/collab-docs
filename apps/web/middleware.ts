import { ACCESS_COOKIE, AccessTokenError, verifyAccessToken } from '@collab-docs/shared';
import { type NextRequest, NextResponse } from 'next/server';
import { jwtAccessSecret } from '@/lib/env';
import { type SessionState, decideRoute, isPerRequestPage } from '@/lib/auth/route-policy';
import {
  CSP_DEFAULT_ORIGINS,
  STRICT_TRANSPORT_SECURITY,
  contentSecurityPolicy,
} from '@/lib/security/headers';
import {
  LAST_WORKSPACE_COOKIE,
  LAST_WORKSPACE_MAX_AGE_SECONDS,
  workspaceIdFromPath,
} from '@/lib/workspaces/last-workspace';

// Skips the api proxy, internal handlers, Next assets and anything with a file extension.
export const config = {
  matcher: ['/((?!api|internal|_next|media|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)'],
};

async function sessionOf(request: NextRequest): Promise<SessionState> {
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (!token) return 'none';
  try {
    await verifyAccessToken(token, jwtAccessSecret());
    return 'valid';
  } catch (error) {
    return error instanceof AccessTokenError && error.reason === 'expired' ? 'expired' : 'none';
  }
}

/** Policy with a fresh nonce for a page rendered for this request; the origins are fixed at build time (next.config). */
function noncePolicy(): string {
  return contentSecurityPolicy({
    s3PublicEndpoint: process.env.CSP_S3_PUBLIC_ENDPOINT ?? CSP_DEFAULT_ORIGINS.s3PublicEndpoint,
    collabPublicUrl: process.env.CSP_COLLAB_PUBLIC_URL ?? CSP_DEFAULT_ORIGINS.collabPublicUrl,
    development: process.env.NODE_ENV !== 'production',
    nonce: btoa(crypto.randomUUID()),
  });
}

export async function middleware(request: NextRequest) {
  const correlationId = request.headers.get('x-correlation-id') ?? crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-correlation-id', correlationId);

  const { pathname, search } = request.nextUrl;
  const decision = decideRoute({ pathname, search, session: await sessionOf(request) });

  let response: NextResponse;
  switch (decision.type) {
    case 'redirect':
      response = NextResponse.redirect(new URL(decision.location, request.url));
      break;
    case 'refresh': {
      // the browser sends the refresh cookie only under /api/auth, so it is renewed there and returns here
      const target = new URL('/api/auth/refresh', request.url);
      target.searchParams.set('next', decision.next);
      response = NextResponse.redirect(target);
      break;
    }
    default: {
      // workspace pages are dynamic (they read the session), so they can carry a nonce; the rest may be static
      const policy = isPerRequestPage(pathname) ? noncePolicy() : null;
      if (policy) requestHeaders.set('content-security-policy', policy);
      response = NextResponse.next({ request: { headers: requestHeaders } });
      if (policy) response.headers.set('content-security-policy', policy);
      // remember the workspace the user is looking at, so `/workspaces` can send them back to it
      const workspaceId = workspaceIdFromPath(pathname);
      if (workspaceId && request.cookies.get(LAST_WORKSPACE_COOKIE)?.value !== workspaceId) {
        response.cookies.set(LAST_WORKSPACE_COOKIE, workspaceId, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: request.headers.get('x-forwarded-proto') === 'https',
          maxAge: LAST_WORKSPACE_MAX_AGE_SECONDS,
        });
      }
    }
  }
  response.headers.set('x-correlation-id', correlationId);
  // read at request time like the rest of the runtime environment; the TLS-terminating layer sits in front of staging
  if (process.env.APP_ENV === 'staging') {
    response.headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
  }
  return response;
}
