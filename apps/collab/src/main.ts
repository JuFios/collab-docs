import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@collab-docs/nest';
import { AppModule } from './app.module';
import { configureApp, createInternalApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApp(app);
  await app.init();
  const internal = await createInternalApp(app);
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }) ?? 4001, '0.0.0.0');
  await internal.listen(config.get('COLLAB_INTERNAL_PORT', { infer: true }), '0.0.0.0');
}

void bootstrap();
