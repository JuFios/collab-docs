import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadConfigOrExit } from '@collab-docs/shared/nest';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const config = loadConfigOrExit();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(config.PORT ?? 4001, '0.0.0.0');
}

void bootstrap();
