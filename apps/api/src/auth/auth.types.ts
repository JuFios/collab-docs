import type { Request } from 'express';

/** Identity attached to the request by `JwtAuthGuard`; derived from the token alone (no database read). */
export interface RequestUser {
  id: string;
  /** Access token id. */
  jti: string;
}

export type AuthenticatedRequest = Request & { user?: RequestUser };
