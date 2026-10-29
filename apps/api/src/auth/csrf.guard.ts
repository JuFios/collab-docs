import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@collab-docs/shared';
import { AppException, type AppConfig, corsOrigins } from '@collab-docs/nest';
import { readBearer, readCookie } from './cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global CSRF defence on top of SameSite=Lax. A state-changing request that is authenticated by cookies
 * (`cd_at` or `cd_rt`, which includes refresh and logout) must come from an origin CORS lets in with credentials
 * (`WEB_ORIGIN` and `CORS_ALLOWED_ORIGINS`), so the two lists can never disagree. Requests with a Bearer
 * header (not attached by browsers automatically) and requests without auth cookies (login, webhooks)
 * are not exposed to cross-site cookie riding and pass.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowed: ReadonlySet<string>;

  constructor(config: ConfigService<AppConfig, true>) {
    this.allowed = new Set(
      corsOrigins({
        WEB_ORIGIN: config.get('WEB_ORIGIN', { infer: true }),
        CORS_ALLOWED_ORIGINS: config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
      }),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;
    if (readBearer(request)) return true;
    if (!readCookie(request, ACCESS_COOKIE) && !readCookie(request, REFRESH_COOKIE)) return true;
    if (request.headers.origin && this.allowed.has(request.headers.origin)) return true;
    throw new AppException('CSRF_REJECTED', 'Cross-origin request rejected');
  }
}
