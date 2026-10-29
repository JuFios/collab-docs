import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlanLimitsService } from './plan-limits.service';

/**
 * Plan limits on their own, without the workspace controllers: the worker process needs the limits (billing) but
 * serves no HTTP, so it must not load controllers whose guards need the HTTP platform (rate limiting).
 */
@Module({
  imports: [PrismaModule],
  providers: [PlanLimitsService],
  exports: [PlanLimitsService],
})
export class PlanLimitsModule {}
