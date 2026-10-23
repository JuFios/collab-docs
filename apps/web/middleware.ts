import { ACCESS_COOKIE, AccessTokenError, verifyAccessToken } from '@collab-docs/shared';
import { type NextRequest, NextResponse } from 'next/server';
import { jwtAccessSecret } from '@/lib/env';
import { type SessionState, decideRoute } from '@/lib/auth/route-policy';

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
    default:
      response = NextResponse.next({ request: { headers: requestHeaders } });
  }
  response.headers.set('x-correlation-id', correlationId);
  return response;
}
