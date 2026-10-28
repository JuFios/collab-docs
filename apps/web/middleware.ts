import { ACCESS_COOKIE, AccessTokenError, verifyAccessToken } from '@collab-docs/shared';
import { type NextRequest, NextResponse } from 'next/server';
import { jwtAccessSecret } from '@/lib/env';
import { type SessionState, decideRoute } from '@/lib/auth/route-policy';
import { STRICT_TRANSPORT_SECURITY } from '@/lib/security/headers';
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
      response = NextResponse.next({ request: { headers: requestHeaders } });
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
