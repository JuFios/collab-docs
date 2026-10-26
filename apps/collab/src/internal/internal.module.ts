import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import {
  AllExceptionsFilter,
  type AppConfig,
  platformLoggerModule,
  createValidationPipe,
} from '@collab-docs/nest';
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

/** The main application's configuration, visible to every module of the internal application (the logger reads it). */
@Global()
@Module({})
class SharedConfigModule {
  static forRoot(config: ConfigService<AppConfig, true>): DynamicModule {
    return {
      module: SharedConfigModule,
      providers: [{ provide: ConfigService, useValue: config }],
      exports: [ConfigService],
    };
  }
}

/** A second Nest application on the internal port that shares the main application's providers. */
@Module({})
export class InternalModule {
  static forRoot(shared: InternalDeps): DynamicModule {
    return {
      module: InternalModule,
      imports: [SharedConfigModule.forRoot(shared.config), platformLoggerModule()],
      controllers: [InternalController],
      providers: [
        InternalTokenGuard,
        { provide: APP_PIPE, useFactory: createValidationPipe },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: RoomManager, useValue: shared.rooms },
        { provide: DOCUMENT_STORE, useValue: shared.store },
        { provide: VersionRestoreService, useValue: shared.restore },
      ],
    };
  }
}
