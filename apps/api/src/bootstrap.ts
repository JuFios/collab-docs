import type { NestExpressApplication } from '@nestjs/platform-express';
import { type AppConfig, configureHttpApp } from '@collab-docs/shared/nest';
import { setupSwagger } from './swagger';

/** Everything `main.ts` does before `listen`, shared with the integration tests and the OpenAPI export. */
export function configureApp(app: NestExpressApplication, config: AppConfig) {
  configureHttpApp(app, config);
  return setupSwagger(app);
}
