import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@collab-docs/nest';
import { AppModule } from './app.module';
import { configureApp, connectInternalApi } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApp(app);
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  connectInternalApi(app, config.get('COLLAB_INTERNAL_PORT', { infer: true }));
  await app.startAllMicroservices();
  await app.listen(config.get('PORT', { infer: true }) ?? 4001, '0.0.0.0');
}

void bootstrap();
