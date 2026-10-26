import { ConfigService } from '@nestjs/config';
import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type AppConfig, configureHttpApp } from '@collab-docs/nest';
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

/**
 * The internal API (flush, restore, close) as a TCP microservice of the same application, so it shares the rooms
 * and the store through the one DI container. Call it before `app.init()`, then `startAllMicroservices()`.
 */
export function connectInternalApi(
  app: NestExpressApplication,
  port: number,
  host = '0.0.0.0',
): void {
  app.connectMicroservice<MicroserviceOptions>(
    { transport: Transport.TCP, options: { host, port } },
    { inheritAppConfig: true },
  );
}
