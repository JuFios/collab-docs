import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WsAdapter } from '@nestjs/platform-ws';
import type { WebSocketServer } from 'ws';

/**
 * The stock `WsAdapter` with the two differences the collab protocol needs. Upgrades are routed by
 * path prefix (`/ws/<documentId>`, the stock adapter matches the exact path), and message handlers are not
 * bound (the stock adapter would JSON-parse every binary frame; the gateway reads the frames itself).
 */
export class CollabWsAdapter extends WsAdapter {
  constructor(
    httpServer: HttpServer,
    /** Largest frame accepted; a bigger one makes `ws` close the socket with 1009. */
    private readonly maxPayload: number,
  ) {
    super(httpServer);
  }

  override create(port: number, options: Record<string, unknown> = {}): WebSocketServer {
    return super.create(port, { ...options, maxPayload: this.maxPayload }) as WebSocketServer;
  }

  override bindMessageHandlers(): void {
    // binary protocol: the gateway attaches its own `message` listener
  }

  protected override ensureHttpServerExists(
    port: number,
    httpServer = this.httpServer as HttpServer,
  ) {
    if (this.httpServersRegistry.has(port)) return undefined;
    this.httpServersRegistry.set(port, httpServer);
    httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(request.url ?? '/', 'http://collab').pathname;
      const target = (this.wsServersRegistry.get(port) ?? []).find(
        (server: { path: string }) =>
          pathname === server.path || pathname.startsWith(`${server.path}/`),
      );
      if (!target) return;
      target.handleUpgrade(request, socket, head, (client: unknown) => {
        target.emit('connection', client, request);
      });
    });
    return httpServer;
  }
}
