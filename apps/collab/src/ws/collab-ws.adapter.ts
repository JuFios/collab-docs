import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketAdapter } from '@nestjs/common';
import { type WebSocket, WebSocketServer } from 'ws';

/**
 * Nest's stock `WsAdapter` routes upgrades by exact path and speaks JSON messages. The collab protocol
 * needs binary frames on `/ws/<documentId>`, so this adapter takes over the upgrade: any path below the
 * gateway's `path` is accepted and the gateway sorts out which document it is. It does not bind message
 * handlers: the gateway reads the frames itself.
 */
export class CollabWsAdapter implements WebSocketAdapter<WebSocketServer, WebSocket> {
  private readonly servers: WebSocketServer[] = [];

  constructor(
    private readonly httpServer: HttpServer,
    /** Largest frame accepted; a bigger one makes `ws` close the socket with 1009. */
    private readonly maxPayload: number,
  ) {}

  create(_port: number, options: { path?: string } = {}): WebSocketServer {
    const base = (options.path ?? '/').replace(/\/+$/, '');
    const server = new WebSocketServer({ noServer: true, maxPayload: this.maxPayload });
    this.httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(request.url ?? '/', 'http://collab').pathname;
      if (pathname !== base && !pathname.startsWith(`${base}/`)) return;
      server.handleUpgrade(request, socket, head, (client) => {
        server.emit('connection', client, request);
      });
    });
    this.servers.push(server);
    return server;
  }

  bindClientConnect(server: WebSocketServer, callback: (...args: unknown[]) => void): void {
    server.on('connection', callback);
  }

  bindClientDisconnect(client: WebSocket, callback: (...args: unknown[]) => void): void {
    client.on('close', callback);
  }

  bindMessageHandlers(): void {
    // binary protocol: the gateway attaches its own `message` listener
  }

  close(server: WebSocketServer): void {
    for (const client of server.clients) client.terminate();
    server.close();
  }

  dispose(): Promise<void> {
    this.servers.forEach((server) => this.close(server));
    return Promise.resolve();
  }
}
