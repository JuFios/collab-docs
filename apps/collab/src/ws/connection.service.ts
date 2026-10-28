import type { IncomingMessage } from 'node:http';
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RawData, WebSocket } from 'ws';
import { COLLAB_CLOSE } from '@collab-docs/shared';
import {
  type AppConfig,
  resolveCorrelationId,
  verifyCollabTicket,
  InjectPinoLogger,
  PinoLogger,
} from '@collab-docs/nest';
import { AccessReevaluator } from '../access/access-reevaluator.service';
import { AccessService, type Identity } from '../access/access.service';
import { CollabMetrics } from '../metrics/collab-metrics.service';
import type { DocRoom } from '../rooms/doc-room';
import { presenceColor } from '../rooms/presence';
import { RoomManager } from '../rooms/room-manager';
import { WsConnection } from './ws-connection';

const PING_INTERVAL_MS = 30_000;
/** Messages a client may send while its ticket and permissions are still being checked. */
const MAX_PENDING_MESSAGES = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/**
 * The life of one socket: ticket → permissions → room → message loop. All close codes of spec §5 are
 * decided here. The hot path (a message from an admitted client) goes straight to the room.
 */
@Injectable()
export class ConnectionService implements OnModuleInit, OnApplicationShutdown {
  private readonly sockets = new Set<WebSocket>();
  private readonly alive = new WeakSet<WebSocket>();
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly access: AccessService,
    private readonly reevaluator: AccessReevaluator,
    private readonly rooms: RoomManager,
    private readonly metrics: CollabMetrics,
    @InjectPinoLogger(ConnectionService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    // y-websocket clients answer pings automatically; a socket that stays silent is dead
    this.pingTimer = setInterval(() => {
      for (const socket of this.sockets) {
        if (!this.alive.has(socket)) {
          socket.terminate();
          continue;
        }
        this.alive.delete(socket);
        socket.ping();
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  onApplicationShutdown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  /** Entry point for a freshly upgraded socket. Never rejects. */
  accept(socket: WebSocket, request: IncomingMessage): void {
    this.sockets.add(socket);
    this.alive.add(socket);
    socket.on('pong', () => this.alive.add(socket));
    socket.on('error', (error) => this.logger.warn({ err: error }, 'collab socket error'));

    const state: { conn: WsConnection | null; documentId: string; closed: boolean } = {
      conn: null,
      documentId: '',
      closed: false,
    };
    const pending: Uint8Array[] = [];
    let deliver: (message: Uint8Array) => void = (message) => {
      if (pending.length < MAX_PENDING_MESSAGES) pending.push(message);
      else socket.close(COLLAB_CLOSE.rateLimited, 'rate limited');
    };

    socket.on('message', (data, isBinary) => {
      if (isBinary) deliver(toBytes(data));
    });
    socket.on('close', (code) => {
      state.closed = true;
      this.sockets.delete(socket);
      this.metrics.socketClosed(code);
      if (state.conn) this.rooms.detach(state.conn);
      else if (state.documentId) this.rooms.releaseIfEmpty(state.documentId);
    });

    void this.admit(socket, request, state, (room, conn) => {
      deliver = (message) => room.receive(conn, message);
      for (const message of pending.splice(0)) deliver(message);
    }).catch((error) => {
      // admission has its own guards; this only keeps a bug from leaving the socket open and nobody notified
      this.logger.error({ err: error }, 'collab admission failed');
      socket.close(1011, 'internal error');
    });
  }

  private async admit(
    socket: WebSocket,
    request: IncomingMessage,
    state: { conn: WsConnection | null; documentId: string; closed: boolean },
    ready: (room: DocRoom, conn: WsConnection) => void,
  ): Promise<void> {
    const correlationId = resolveCorrelationId(request.headers['x-correlation-id']);
    const log = this.logger.logger.child({ correlationId, documentId: '' });
    const fail = (code: number, reason: string) => {
      log.info({ event: 'collab.connection_refused', code, reason }, 'collab connection refused');
      socket.close(code, reason);
    };

    let url: URL;
    let documentId: string;
    try {
      url = new URL(request.url ?? '/', 'http://collab');
      documentId = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    } catch {
      // the path is not even a document name (`/ws/%` makes decodeURIComponent throw), so it is "not found"
      return fail(COLLAB_CLOSE.notFound, 'document not found');
    }
    log.setBindings({ documentId });

    if (!UUID.test(documentId)) return fail(COLLAB_CLOSE.notFound, 'document not found');

    let identity: Identity;
    let ticketCorrelationId: string | undefined;
    try {
      const claims = await verifyCollabTicket(
        this.config.get('COLLAB_TICKET_SECRET', { infer: true }),
        url.searchParams.get('ticket') ?? '',
      );
      if (claims.docId !== documentId) return fail(COLLAB_CLOSE.ticketInvalid, 'ticket invalid');
      identity = { userId: claims.sub, linkId: claims.linkId };
      ticketCorrelationId = claims.correlationId;
      if (ticketCorrelationId) log.setBindings({ ticketCorrelationId });
    } catch {
      return fail(COLLAB_CLOSE.ticketInvalid, 'ticket invalid');
    }

    try {
      const outcome = await this.access.resolve(identity, documentId);
      if (state.closed) return;
      if (outcome.status === 'not_found') return fail(COLLAB_CLOSE.notFound, 'document not found');
      if (outcome.status === 'deleted') return fail(COLLAB_CLOSE.deleted, 'document deleted');
      if (outcome.status === 'forbidden') return fail(COLLAB_CLOSE.forbidden, 'no access');

      const userName = identity.userId ? await this.access.userName(identity.userId) : undefined;
      if (userName === null) return fail(COLLAB_CLOSE.forbidden, 'no access');

      state.documentId = documentId;
      const room = await this.rooms.acquire(documentId);
      if (state.closed) {
        this.rooms.releaseIfEmpty(documentId);
        return;
      }
      // a cold room takes a database round-trip to load, and permissions can change meanwhile: decide again
      const latest = await this.access.resolve(identity, documentId);
      if (state.closed) {
        this.rooms.releaseIfEmpty(documentId);
        return;
      }
      if (latest.status === 'not_found') return fail(COLLAB_CLOSE.notFound, 'document not found');
      if (latest.status === 'deleted') return fail(COLLAB_CLOSE.deleted, 'document deleted');
      if (latest.status === 'forbidden') return fail(COLLAB_CLOSE.forbidden, 'no access');
      const conn = new WsConnection(
        socket,
        identity.userId ?? null,
        userName ?? room.nextGuestName(),
        presenceColor(identity.userId ?? identity.linkId ?? 'guest'),
        ticketCorrelationId ?? correlationId,
      );
      if (!room.connect(conn, latest.access)) return;
      state.conn = conn;
      const session = { conn, room, documentId, identity, workspaceId: latest.workspaceId };
      this.rooms.attach(session);
      this.reevaluator.watchExpiry(session, latest.expiresAt);
      log.info(
        { event: 'collab.connected', connectionId: conn.id, access: latest.access },
        'collab connected',
      );
      ready(room, conn);
    } catch (error) {
      log.error({ err: error }, 'collab connection failed');
      socket.close(1011, 'internal error');
    }
  }
}
