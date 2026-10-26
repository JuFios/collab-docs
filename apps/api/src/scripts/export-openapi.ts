import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../app.module';
import { configureApp } from '../bootstrap';

/** Builds the app without listening (connections are lazy) and writes the OpenAPI document to docs/openapi.json. */
async function exportOpenApi(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  const document = configureApp(app);
  const target = path.resolve(__dirname, '../../../../docs/openapi.json');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
}

void exportOpenApi();
