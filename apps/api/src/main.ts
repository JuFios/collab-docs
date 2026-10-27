import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@collab-docs/nest';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // the billing webhook verifies its signature over the exact bytes received
    rawBody: true,
  });
  configureApp(app);
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }) ?? 4000, '0.0.0.0');
}

void bootstrap();
