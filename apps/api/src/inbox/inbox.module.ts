import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeEventsModule } from '../realtime/realtime.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

/** Notifications API of the signed-in user; also the one place that writes them (`InboxService`). */
@Module({
  imports: [PrismaModule, RealtimeEventsModule, NotificationsModule],
  controllers: [InboxController],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
