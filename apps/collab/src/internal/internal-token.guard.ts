import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, type AppConfig } from '@collab-docs/nest';

/** The internal port is reachable only inside the network, and every message still has to carry `INTERNAL_API_TOKEN`. */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const data = context.switchToRpc().getData<{ token?: unknown } | null>();
    const token = typeof data?.token === 'string' ? data.token : '';
    const expected = Buffer.from(this.config.get('INTERNAL_API_TOKEN', { infer: true }));
    const given = Buffer.from(token);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    throw new AppException('UNAUTHENTICATED', 'Internal token required');
  }
}
