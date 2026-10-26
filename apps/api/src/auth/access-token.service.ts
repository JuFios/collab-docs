import { Injectable } from '@nestjs/common';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessTokenError,
  type AccessTokenClaims,
} from '@collab-docs/shared';

/**
 * Issues and verifies the access JWT (HS256, `aud=api`, `sub`, `jti`, `iat`, `exp`) with `@nestjs/jwt`. The web
 * app's edge middleware verifies the same token with `verifyAccessToken` from `@collab-docs/shared` (jose), so
 * the token format is a contract between the two; `access-token.service.spec.ts` pins it.
 */
@Injectable()
export class AccessTokenService {
  constructor(private readonly jwt: JwtService) {}

  async sign(
    userId: string,
    options: { jti?: string; ttlSeconds?: number; now?: Date } = {},
  ): Promise<{ token: string; jti: string; expiresIn: number }> {
    const jti = options.jti ?? crypto.randomUUID();
    const expiresIn = options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
    const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
    const token = await this.jwt.signAsync(
      { iat: issuedAt },
      { subject: userId, jwtid: jti, expiresIn },
    );
    return { token, jti, expiresIn };
  }

  /** Throws `AccessTokenError` (`expired` or `invalid`). */
  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const payload = await this.jwt.verifyAsync<Partial<AccessTokenClaims>>(token);
      if (!payload.sub || !payload.jti || typeof payload.exp !== 'number') {
        throw new AccessTokenError('invalid');
      }
      return { sub: payload.sub, jti: payload.jti, exp: payload.exp };
    } catch (error) {
      if (error instanceof AccessTokenError) throw error;
      throw new AccessTokenError(error instanceof TokenExpiredError ? 'expired' : 'invalid');
    }
  }
}
