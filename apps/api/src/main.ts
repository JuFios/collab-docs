import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { currentConfig, loadConfigOrExit, setCurrentConfig } from '@collab-docs/shared/nest';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  setCurrentConfig(loadConfigOrExit());
  const config = currentConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApp(app, config);
  await app.listen(config.PORT ?? 4000, '0.0.0.0');
}

void bootstrap();
