import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AuthenticatedRequest, RequestUser } from './auth.types';
import { AppException } from '@collab-docs/nest';

export { IS_PUBLIC_KEY, Public } from '@collab-docs/nest';

/** The authenticated user. Only valid on non-`@Public()` routes. */
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): RequestUser => {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new AppException('UNAUTHENTICATED', 'Authentication required');
    return user;
  },
);
