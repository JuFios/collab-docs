import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PinoAppLogger } from '@collab-docs/nest';
import { WorkerModule } from './worker.module';

// Queue processors (search-sync, mail, ...) are registered by their stage modules in WorkerModule.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(PinoAppLogger));
  // The BullMQ workers and the Redis connections keep the process alive; once the shutdown hooks have closed
  // them the process ends on its own. (A timer kept alive here made `docker stop` wait for SIGKILL: as PID 1
  // the process ignores the signal Nest re-raises after the hooks, so only an empty event loop ends it.)
  app.enableShutdownHooks();
}

void bootstrap();
