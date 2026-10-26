import { Controller, Get, Global, Inject, Injectable, Module, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './public';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { type HealthResponse, type ReadyResponse } from '@collab-docs/shared';
import { REDIS_CLIENT } from './redis';

const CHECK_TIMEOUT_MS = 2000;

type Check = () => Promise<unknown>;

/** Dependency probes behind `/ready`. Modules register their own (Redis here, Postgres in the api). */
@Injectable()
export class ReadinessService {
  private readonly checks = new Map<string, Check>();

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.register('redis', () => redis.ping());
  }

  register(name: string, check: Check): void {
    this.checks.set(name, check);
  }

  async run(): Promise<ReadyResponse> {
    const entries = await Promise.all(
      [...this.checks].map(async ([name, check]): Promise<[string, 'up' | 'down']> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            check(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
            }),
          ]);
          return [name, 'up'];
        } catch {
          return [name, 'down'];
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    const ok = entries.every(([, state]) => state === 'up');
    return { status: ok ? 'ok' : 'unavailable', checks };
  }
}

export class HealthResponseDto implements HealthResponse {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';
}

export class ReadyResponseDto implements ReadyResponse {
  @ApiProperty({ enum: ['ok', 'unavailable'] })
  status!: 'ok' | 'unavailable';

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', enum: ['up', 'down'] },
  })
  checks!: Record<string, 'up' | 'down'>;
}

@ApiTags('ops')
@Public()
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('health')
  @ApiOkResponse({ type: HealthResponseDto })
  health(): HealthResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({ type: ReadyResponseDto })
  @ApiServiceUnavailableResponse({ type: ReadyResponseDto })
  async ready(@Res() res: Response): Promise<void> {
    const body = await this.readiness.run();
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  }
}

@Global()
@Module({
  controllers: [HealthController],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class HealthModule {}
