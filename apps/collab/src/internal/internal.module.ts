import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@collab-docs/shared/nest';
import { VersionRestoreService } from '../persistence/version-restore.service';
import { DOCUMENT_STORE, type DocumentStore } from '../rooms/document-store';
import { RoomManager } from '../rooms/room-manager';
import { InternalController } from './internal.controller';
import { InternalTokenGuard } from './internal-token.guard';

export interface InternalDeps {
  config: AppConfig;
  rooms: RoomManager;
  store: DocumentStore;
  restore: VersionRestoreService;
}

/** A second Nest application on the internal port that shares the main application's providers. */
@Module({})
export class InternalModule {
  static forRoot(shared: InternalDeps): DynamicModule {
    return {
      module: InternalModule,
      controllers: [InternalController],
      providers: [
        InternalTokenGuard,
        { provide: APP_CONFIG, useValue: shared.config },
        { provide: RoomManager, useValue: shared.rooms },
        { provide: DOCUMENT_STORE, useValue: shared.store },
        { provide: VersionRestoreService, useValue: shared.restore },
      ],
    };
  }
}
