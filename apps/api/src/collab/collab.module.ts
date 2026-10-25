import { Module } from '@nestjs/common';
import { CollabTicketController } from './collab-ticket.controller';
import { TicketThrottleGuard } from './ticket-throttle.guard';

@Module({
  controllers: [CollabTicketController],
  providers: [TicketThrottleGuard],
})
export class CollabModule {}
