import { timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Global,
  Injectable,
  Module,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { AppConfig } from './config';
import { AppException } from './exceptions';
import { Public } from './public';
import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<'route' | 'method' | 'status'>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['route', 'method', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
  }

  /** Records every request, labelled by route pattern (not raw URL) to keep cardinality bounded. */
  httpMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const end = this.httpDuration.startTimer();
      res.once('finish', () => {
        const pattern = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : '';
        // Nest's catch-all 404 handler is registered as a wildcard route; label it like any unrouted request
        const route = pattern && !pattern.includes('*') ? pattern : 'unmatched';
        end({ route, method: req.method, status: String(res.statusCode) });
      });
      next();
    };
  }
}

/**
 * `/metrics` is not behind the session guard (Prometheus has no session) and, on collab, shares the port that browsers
 * open WebSockets on. It answers only to the bearer token (`METRICS_TOKEN`), compared in constant time.
 */
@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const given = Buffer.from(/^Bearer (.+)$/i.exec(header)?.[1] ?? '');
    const expected = Buffer.from(this.config.get('METRICS_TOKEN', { infer: true }));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    throw new AppException('UNAUTHENTICATED', 'Metrics token required');
  }
}

@ApiExcludeController()
@Public()
@UseGuards(MetricsTokenGuard)
@SkipThrottle()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
