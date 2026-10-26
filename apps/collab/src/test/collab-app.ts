import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { configureApp, createInternalApp } from '../bootstrap';

export interface RunningCollab {
  app: NestExpressApplication;
  internal: NestExpressApplication;
  /** `ws://127.0.0.1:<port>/ws` — what the ticket endpoint hands out as `wsUrl`. */
  wsUrl: string;
  httpUrl: string;
  internalUrl: string;
  stop(): Promise<void>;
}

/** Boots the whole service (public and internal port) on random ports. */
export async function startCollab(): Promise<RunningCollab> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  await app.init();
  const internal = await createInternalApp(app);
  await app.listen(0, '127.0.0.1');
  await internal.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const internalPort = (internal.getHttpServer().address() as AddressInfo).port;
  return {
    app,
    internal,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    httpUrl: `http://127.0.0.1:${port}`,
    internalUrl: `http://127.0.0.1:${internalPort}`,
    async stop() {
      await internal.close();
      await app.close();
    },
  };
}
