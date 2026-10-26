import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type AppConfig, configureHttpApp, correlationMiddleware } from '@collab-docs/nest';
import { InternalModule } from './internal/internal.module';
import { VersionRestoreService } from './persistence/version-restore.service';
import { DOCUMENT_STORE } from './rooms/document-store';
import { RoomManager } from './rooms/room-manager';
import { CollabWsAdapter } from './ws/collab-ws.adapter';

/** Frames carry the update (≤ COLLAB_MAX_UPDATE_BYTES) plus a few bytes of protocol framing. */
const FRAME_OVERHEAD_BYTES = 64;

/** Everything `main.ts` does before `listen`, shared with the integration tests. */
export function configureApp(app: NestExpressApplication): void {
  configureHttpApp(app);
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  app.useWebSocketAdapter(
    new CollabWsAdapter(
      app.getHttpServer(),
      config.get('COLLAB_MAX_UPDATE_BYTES', { infer: true }) + FRAME_OVERHEAD_BYTES,
    ),
  );
}

/** The application behind port 4002; call after `app.init()` (it reuses the main app's room manager). */
export async function createInternalApp(
  app: NestExpressApplication,
): Promise<NestExpressApplication> {
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
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
  internal.useBodyParser('json', { limit: config.get('HTTP_BODY_LIMIT', { infer: true }) });
  internal.enableShutdownHooks();
  return internal;
}
