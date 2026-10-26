import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttpApp } from '@collab-docs/nest';
import { setupSwagger } from './swagger';

/** Everything `main.ts` does before `listen`, shared with the integration tests and the OpenAPI export. */
export function configureApp(app: NestExpressApplication) {
  configureHttpApp(app);
  return setupSwagger(app);
}
