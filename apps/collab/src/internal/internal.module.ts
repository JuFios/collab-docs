import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@collab-docs/shared/nest';
import { RoomManager } from '../rooms/room-manager';
import { InternalController } from './internal.controller';
import { InternalTokenGuard } from './internal-token.guard';

/** A second Nest application on the internal port that shares the main application's providers. */
@Module({})
export class InternalModule {
  static forRoot(shared: { config: AppConfig; rooms: RoomManager }): DynamicModule {
    return {
      module: InternalModule,
      controllers: [InternalController],
      providers: [
        InternalTokenGuard,
        { provide: APP_CONFIG, useValue: shared.config },
        { provide: RoomManager, useValue: shared.rooms },
      ],
    };
  }
}
