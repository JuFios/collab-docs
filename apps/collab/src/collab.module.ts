import { Module } from '@nestjs/common';
import { AccessReevaluator } from './access/access-reevaluator.service';
import { AccessService } from './access/access.service';
import { PermissionEventsService } from './events/permission-events.service';
import { PersistenceModule } from './persistence/persistence.module';
import { CollabMetricsModule } from './metrics/collab-metrics.module';
import { VersionRestoreService } from './persistence/version-restore.service';
import { RoomManager } from './rooms/room-manager';
import { CollabGateway } from './ws/collab.gateway';
import { ConnectionService } from './ws/connection.service';

@Module({
  imports: [CollabMetricsModule, PersistenceModule],
  providers: [
    AccessService,
    AccessReevaluator,
    RoomManager,
    ConnectionService,
    CollabGateway,
    PermissionEventsService,
    VersionRestoreService,
  ],
  exports: [RoomManager, VersionRestoreService, PersistenceModule],
})
export class CollabModule {}
