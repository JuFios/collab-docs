import { Module } from '@nestjs/common';
import { CollabInternalClient } from './collab-internal.client';
import { CollabTicketController } from './collab-ticket.controller';
import { TicketThrottleGuard } from './ticket-throttle.guard';

@Module({
  controllers: [CollabTicketController],
  providers: [TicketThrottleGuard, CollabInternalClient],
  exports: [CollabInternalClient],
})
export class CollabModule {}
