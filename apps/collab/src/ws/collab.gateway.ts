import type { IncomingMessage } from 'node:http';
import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { ConnectionService } from './connection.service';

/** The public WebSocket endpoint: `/ws/<documentId>?ticket=…`. The adapter lets any path below `/ws` through. */
@WebSocketGateway({ path: '/ws' })
export class CollabGateway implements OnGatewayConnection {
  constructor(private readonly connections: ConnectionService) {}

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    this.connections.accept(client, request);
  }
}
