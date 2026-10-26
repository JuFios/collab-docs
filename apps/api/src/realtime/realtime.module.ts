import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { RealtimeEventsService } from './realtime-events.service';
import { PermissionsModule } from '../permissions/permissions.module';

@Module({
  imports: [PermissionsModule],
  controllers: [EventsController],
  providers: [RealtimeEventsService],
  exports: [RealtimeEventsService],
})
export class RealtimeEventsModule {}
