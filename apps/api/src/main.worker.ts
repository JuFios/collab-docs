import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadConfigOrExit } from '@collab-docs/shared/nest';
import { AppModule } from './app.module';

// Placeholder worker process: queue processors (search-sync, mail, ...) are registered here later.
async function bootstrap(): Promise<void> {
  loadConfigOrExit();
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  // Nothing holds the event loop open until processors exist; keep the process alive.
  setInterval(() => undefined, 60_000);
}

void bootstrap();
