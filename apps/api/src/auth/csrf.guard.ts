import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@collab-docs/shared';
import { APP_CONFIG, AppException, type AppConfig } from '@collab-docs/shared/nest';
import { readBearer, readCookie } from './cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global CSRF defence on top of SameSite=Lax. A state-changing request that is authenticated by cookies
 * (`cd_at` or `cd_rt`, which includes refresh and logout) must come from `WEB_ORIGIN`. Requests with a Bearer
 * header (not attached by browsers automatically) and requests without auth cookies (login, webhooks)
 * are not exposed to cross-site cookie riding and pass.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;
    if (readBearer(request)) return true;
    if (!readCookie(request, ACCESS_COOKIE) && !readCookie(request, REFRESH_COOKIE)) return true;
    if (request.headers.origin === new URL(this.config.WEB_ORIGIN).origin) return true;
    throw new AppException('CSRF_REJECTED', 'Cross-origin request rejected');
  }
}
