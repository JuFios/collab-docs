import { Module } from '@nestjs/common';
import { CollabInternalClient } from './collab-internal.client';
import { CollabTicketController } from './collab-ticket.controller';
import { PermissionsModule } from '../permissions/permissions.module';

@Module({
  imports: [PermissionsModule],
  controllers: [CollabTicketController],
  providers: [CollabInternalClient],
  exports: [CollabInternalClient],
})
export class CollabModule {}
