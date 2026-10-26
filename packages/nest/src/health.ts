import {
  Controller,
  Get,
  Global,
  Inject,
  Injectable,
  Module,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthIndicatorFunction,
  HealthIndicatorService,
  TerminusModule,
} from '@nestjs/terminus';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { Public } from './public';
import { REDIS_CLIENT } from './redis';

const CHECK_TIMEOUT_MS = 2000;

type Probe = () => Promise<unknown>;

/**
 * Dependency probes behind `/ready`, each reported as a Terminus health indicator. Modules register their own
 * (Redis here, Postgres in the api and collab); a probe that fails or takes longer than 2 s reports `down`.
 */
@Injectable()
export class ReadinessService {
  private readonly probes = new Map<string, Probe>();

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    private readonly indicators: HealthIndicatorService,
  ) {
    this.register('redis', () => redis.ping());
  }

  register(name: string, probe: Probe): void {
    this.probes.set(name, probe);
  }

  /** One indicator function per registered probe, for `HealthCheckService.check`. */
  indicatorFunctions(): HealthIndicatorFunction[] {
    return [...this.probes].map(([name, probe]): HealthIndicatorFunction => async () => {
      const indicator = this.indicators.check(name);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          probe(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
          }),
        ]);
        return indicator.up();
      } catch (error) {
        return error instanceof Error && error.message === 'timeout'
          ? indicator.down({ message: 'timeout' })
          : indicator.down();
      } finally {
        clearTimeout(timer);
      }
    });
  }
}

@ApiTags('ops')
@Public()
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(
    private readonly terminus: HealthCheckService,
    private readonly readiness: ReadinessService,
  ) {}

  /** Liveness: the process answers. Checks no dependency, so a database outage never restarts the container. */
  @Get('health')
  @HealthCheck({ swaggerDocumentation: false })
  @ApiOkResponse({ description: 'The process is alive; no dependency is checked' })
  health() {
    return this.terminus.check([]);
  }

  /** Readiness: every registered dependency answers; `503` with the same body otherwise. */
  @Get('ready')
  @HealthCheck()
  async ready(@Res({ passthrough: true }) res: Response) {
    try {
      return await this.terminus.check(this.readiness.indicatorFunctions());
    } catch (error) {
      // Terminus reports a failing check as a 503 whose body is the check result; keep it out of the error model
      if (error instanceof ServiceUnavailableException) {
        res.status(503);
        return error.getResponse();
      }
      throw error;
    }
  }
}

@Global()
@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: 'json' })],
  controllers: [HealthController],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class HealthModule {}
