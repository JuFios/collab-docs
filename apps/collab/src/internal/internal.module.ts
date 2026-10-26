import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter, type AppConfig, createValidationPipe } from '@collab-docs/nest';
import { VersionRestoreService } from '../persistence/version-restore.service';
import { DOCUMENT_STORE, type DocumentStore } from '../rooms/document-store';
import { RoomManager } from '../rooms/room-manager';
import { InternalController } from './internal.controller';
import { InternalTokenGuard } from './internal-token.guard';

export interface InternalDeps {
  config: ConfigService<AppConfig, true>;
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
        { provide: ConfigService, useValue: shared.config },
        { provide: APP_PIPE, useFactory: createValidationPipe },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: RoomManager, useValue: shared.rooms },
        { provide: DOCUMENT_STORE, useValue: shared.store },
        { provide: VersionRestoreService, useValue: shared.restore },
      ],
    };
  }
}
