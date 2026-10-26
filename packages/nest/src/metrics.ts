import { Controller, Get, Global, Injectable, Module, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
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

@ApiExcludeController()
@Public()
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
