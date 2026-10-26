import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  type AppConfig,
  AllExceptionsFilter,
  configureHttpApp,
  correlationMiddleware,
  createValidationPipe,
} from '@collab-docs/nest';
import { InternalModule } from './internal/internal.module';
import { VersionRestoreService } from './persistence/version-restore.service';
import { DOCUMENT_STORE } from './rooms/document-store';
import { RoomManager } from './rooms/room-manager';
import { CollabWsAdapter } from './ws/collab-ws.adapter';

/** Frames carry the update (≤ COLLAB_MAX_UPDATE_BYTES) plus a few bytes of protocol framing. */
const FRAME_OVERHEAD_BYTES = 64;

/** Everything `main.ts` does before `listen`, shared with the integration tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  configureHttpApp(app, config);
  app.useWebSocketAdapter(
    new CollabWsAdapter(app.getHttpServer(), config.COLLAB_MAX_UPDATE_BYTES + FRAME_OVERHEAD_BYTES),
  );
}

/** The application behind port 4002; call after `app.init()` (it reuses the main app's room manager). */
export async function createInternalApp(
  app: NestExpressApplication,
  config: AppConfig,
): Promise<NestExpressApplication> {
  const internal = await NestFactory.create<NestExpressApplication>(
    InternalModule.forRoot({
      config,
      rooms: app.get(RoomManager),
      store: app.get(DOCUMENT_STORE),
      restore: app.get(VersionRestoreService),
    }),
    { logger: ['error', 'warn'] },
  );
  internal.use(correlationMiddleware);
  internal.useBodyParser('json', { limit: config.HTTP_BODY_LIMIT });
  internal.useGlobalPipes(createValidationPipe());
  internal.useGlobalFilters(new AllExceptionsFilter());
  internal.enableShutdownHooks();
  return internal;
}
