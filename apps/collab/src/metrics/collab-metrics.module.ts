import { Global, Module } from '@nestjs/common';
import { CollabMetrics } from './collab-metrics.service';

@Global()
@Module({ providers: [CollabMetrics], exports: [CollabMetrics] })
export class CollabMetricsModule {}
