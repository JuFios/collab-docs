import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, AppException, type AppConfig } from '@collab-docs/nest';

/** The internal port is reachable only inside the network, and still requires `Authorization: Bearer <INTERNAL_API_TOKEN>`. */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const expected = Buffer.from(this.config.INTERNAL_API_TOKEN);
    const given = Buffer.from(token);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    throw new AppException('UNAUTHENTICATED', 'Internal token required');
  }
}
