import { createServer, type AddressInfo } from 'node:net';
import { firstValueFrom } from 'rxjs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ClientProxyFactory, Transport, type ClientProxy } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { configureApp, connectInternalApi } from '../bootstrap';

/** The answer of an internal API call: `status` is 200, or the `statusCode` of the error body. */
export interface InternalAnswer {
  status: number;
  body: unknown;
}

export interface RunningCollab {
  app: NestExpressApplication;
  /** `ws://127.0.0.1:<port>/ws` — what the ticket endpoint hands out as `wsUrl`. */
  wsUrl: string;
  httpUrl: string;
  internalPort: number;
  /** Sends a message of the internal API; `token: null` leaves the token out. */
  send(
    pattern: string,
    payload: Record<string, unknown>,
    options?: { token?: string | null },
  ): Promise<InternalAnswer>;
  stop(): Promise<void>;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** Boots the whole service (public port and internal API) on random ports. */
export async function startCollab(fixedInternalPort?: number): Promise<RunningCollab> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  const internalPort = fixedInternalPort ?? (await freePort());
  connectInternalApi(app, internalPort, '127.0.0.1');
  await app.startAllMicroservices();
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const client: ClientProxy = ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: '127.0.0.1', port: internalPort },
  });
  const token = process.env.INTERNAL_API_TOKEN;
  return {
    app,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    httpUrl: `http://127.0.0.1:${port}`,
    internalPort,
    async send(pattern, payload, { token: given = token } = {}) {
      try {
        const body = await firstValueFrom(
          client.send(pattern, { ...(given ? { token: given } : {}), ...payload }),
        );
        return { status: 200, body };
      } catch (error) {
        const body = error as { statusCode?: number };
        return { status: body.statusCode ?? 500, body };
      }
    },
    async stop() {
      client.close();
      await app.close();
    },
  };
}
