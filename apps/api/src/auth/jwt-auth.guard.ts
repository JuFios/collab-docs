import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedRequest } from './auth.types';
import { ACCESS_COOKIE, AccessTokenError, verifyAccessToken } from '@collab-docs/shared';
import { AppException, type AppConfig, IS_PUBLIC_KEY } from '@collab-docs/nest';
import { readBearer, readCookie } from './cookies';

/** Global guard: verifies the access JWT locally (no database round trip) and exposes `req.user`. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readBearer(request) ?? readCookie(request, ACCESS_COOKIE);
    if (!token) throw new AppException('UNAUTHENTICATED', 'Authentication required');
    try {
      const claims = await verifyAccessToken(
        token,
        this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      );
      request.user = { id: claims.sub, jti: claims.jti };
      return true;
    } catch (error) {
      if (error instanceof AccessTokenError && error.reason === 'expired') {
        throw new AppException('TOKEN_EXPIRED', 'Access token expired');
      }
      throw new AppException('UNAUTHENTICATED', 'Authentication required');
    }
  }
}
