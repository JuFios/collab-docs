import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/** Marks a route or controller as reachable without authentication (skips the api's `JwtAuthGuard`). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
