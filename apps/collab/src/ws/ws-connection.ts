import { randomUUID } from 'node:crypto';
import { type WebSocket } from 'ws';
import type { RoomConnection } from '../rooms/doc-room';

/** A client that stops reading must not make the server buffer without bound. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/** `RoomConnection` over a `ws` socket. */
export class WsConnection implements RoomConnection {
  readonly id = randomUUID();

  constructor(
    private readonly socket: WebSocket,
    readonly userId: string | null,
    readonly name: string,
    readonly color: string,
  ) {}

  send(data: Uint8Array): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.socket.terminate();
      return;
    }
    this.socket.send(data, { binary: true });
  }

  close(code: number, reason?: string): void {
    // close reasons are limited to 123 bytes
    this.socket.close(code, reason ? reason.slice(0, 100) : undefined);
  }
}
