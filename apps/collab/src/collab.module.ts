import { Module } from '@nestjs/common';
import { AccessReevaluator } from './access/access-reevaluator.service';
import { AccessService } from './access/access.service';
import { PermissionEventsService } from './events/permission-events.service';
import { CollabMetrics } from './metrics/collab-metrics.service';
import { DOCUMENT_STORE, InMemoryDocumentStore } from './rooms/document-store';
import { RoomManager } from './rooms/room-manager';
import { CollabGateway } from './ws/collab.gateway';
import { ConnectionService } from './ws/connection.service';

@Module({
  providers: [
    CollabMetrics,
    AccessService,
    AccessReevaluator,
    RoomManager,
    ConnectionService,
    CollabGateway,
    PermissionEventsService,
    // replaced by the database-backed store with the persistence work
    { provide: DOCUMENT_STORE, useClass: InMemoryDocumentStore },
  ],
  exports: [RoomManager, DOCUMENT_STORE, AccessReevaluator, PermissionEventsService],
})
export class CollabModule {}
