import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AppException, type AppConfig } from '@collab-docs/nest';

/** The internal port is reachable only inside the network, and still requires `Authorization: Bearer <INTERNAL_API_TOKEN>`. */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const expected = Buffer.from(this.config.get('INTERNAL_API_TOKEN', { infer: true }));
    const given = Buffer.from(token);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    throw new AppException('UNAUTHENTICATED', 'Internal token required');
  }
}
