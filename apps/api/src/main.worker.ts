import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PinoAppLogger, loadConfigOrExit, setCurrentConfig } from '@collab-docs/shared/nest';
import { WorkerModule } from './worker.module';

// Queue processors (search-sync, mail, ...) are registered by their stage modules in WorkerModule.
async function bootstrap(): Promise<void> {
  setCurrentConfig(loadConfigOrExit());
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(PinoAppLogger));
  app.enableShutdownHooks();
  // Until processors exist nothing holds the event loop open; keep the process alive.
  setInterval(() => undefined, 60_000);
}

void bootstrap();
