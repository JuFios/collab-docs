import { Inject, Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CollabRoomEvent } from '@collab-docs/shared';
import { type AppConfig, InjectPinoLogger, PinoLogger } from '@collab-docs/nest';
import type { Identity } from '../access/access.service';
import { CollabMetrics } from '../metrics/collab-metrics.service';
import { DocRoom, type RoomConnection, type RoomLimits } from './doc-room';
import { DOCUMENT_STORE, type DocumentStore } from './document-store';

/** A connection that has been admitted to a room, with what is needed to re-evaluate its permissions. */
export interface Session {
  readonly conn: RoomConnection;
  readonly room: DocRoom;
  readonly documentId: string;
  readonly identity: Identity;
  workspaceId: string;
}

interface Entry {
  room: Promise<DocRoom>;
  idleTimer: NodeJS.Timeout | null;
  /** Set while the room is being flushed and destroyed; a new connection waits for it. */
  closing: Promise<void> | null;
}

/** Owns the loaded rooms: loads them lazily, unloads them after a period without connections. */
@Injectable()
export class RoomManager implements BeforeApplicationShutdown {
  private readonly entries = new Map<string, Entry>();
  private readonly sessions = new Map<string, Session>();
  private readonly limits: RoomLimits;
  private readonly idleMs: number;
  private shuttingDown = false;

  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    config: ConfigService<AppConfig, true>,
    private readonly metrics: CollabMetrics,
    @InjectPinoLogger(RoomManager.name) private readonly logger: PinoLogger,
  ) {
    this.limits = {
      maxMessagesPer10s: config.get('COLLAB_MAX_MESSAGES_PER_10S', { infer: true }),
      maxUpdateBytes: config.get('COLLAB_MAX_UPDATE_BYTES', { infer: true }),
      maxDocumentBytes: config.get('COLLAB_MAX_DOCUMENT_BYTES', { infer: true }),
      maxConnections: config.get('COLLAB_MAX_CONNECTIONS_PER_DOCUMENT', { infer: true }),
      maxAwarenessBytes: config.get('COLLAB_MAX_AWARENESS_BYTES', { infer: true }),
    };
    this.idleMs = config.get('COLLAB_ROOM_IDLE_MS', { infer: true });
    metrics.bind(this);
  }

  roomCount(): number {
    return this.entries.size;
  }

  connectionCount(): number {
    return this.sessions.size;
  }

  /** The loaded room, if any (never loads). */
  async find(documentId: string): Promise<DocRoom | undefined> {
    const entry = this.entries.get(documentId);
    if (!entry || entry.closing) return undefined;
    return entry.room.catch(() => undefined);
  }

  /** Returns the room of a document, loading its state on first use. Cancels a pending unload. */
  async acquire(documentId: string): Promise<DocRoom> {
    for (;;) {
      const existing = this.entries.get(documentId);
      if (existing?.closing) {
        await existing.closing;
        continue;
      }
      if (existing) {
        this.cancelIdle(existing);
        return existing.room;
      }
      const entry: Entry = { room: this.load(documentId), idleTimer: null, closing: null };
      this.entries.set(documentId, entry);
      entry.room.catch(() => {
        if (this.entries.get(documentId) === entry) this.entries.delete(documentId);
      });
      return entry.room;
    }
  }

  private async load(documentId: string): Promise<DocRoom> {
    const state = await this.store.load(documentId);
    const room = new DocRoom(
      documentId,
      state,
      this.store,
      this.limits,
      this.metrics,
      this.logger.logger,
    );
    room.onEmpty = () => this.scheduleUnload(documentId);
    return room;
  }

  /** Registers an admitted connection so permission events can find it. */
  attach(session: Session): void {
    this.sessions.set(session.conn.id, session);
  }

  /** Removes a connection; the room unloads once it has been empty for the idle period. */
  detach(conn: RoomConnection): void {
    const session = this.sessions.get(conn.id);
    if (!session) return;
    this.sessions.delete(conn.id);
    session.room.disconnect(conn);
  }

  /** For a connection that went away before it was admitted: unload the room if nobody else uses it. */
  releaseIfEmpty(documentId: string): void {
    const entry = this.entries.get(documentId);
    if (entry && !entry.closing) {
      void entry.room.then((room) => {
        if (room.size === 0) this.scheduleUnload(documentId);
      });
    }
  }

  matching(filter: {
    documentIds?: readonly string[];
    userId?: string;
    workspaceId?: string;
  }): Session[] {
    return [...this.sessions.values()].filter(
      (session) =>
        (!filter.documentIds || filter.documentIds.includes(session.documentId)) &&
        (!filter.userId || session.identity.userId === filter.userId) &&
        (!filter.workspaceId || session.workspaceId === filter.workspaceId),
    );
  }

  /** Deleted documents: write what is pending (restore needs the content), tell the clients, drop the room. */
  async closeDocument(
    documentId: string,
    code: number,
    reason: string,
    event?: CollabRoomEvent,
  ): Promise<boolean> {
    const entry = this.entries.get(documentId);
    if (!entry || entry.closing) return false;
    const room = await entry.room.catch(() => undefined);
    if (!room) return false;
    await this.store.flush(documentId).catch((error: unknown) => {
      // the updates stay buffered and keep being retried; closing the sockets does not depend on them
      this.logger.error({ err: error, documentId }, 'flush before closing a room failed');
    });
    room.closeAll(code, reason, event);
    await this.unload(documentId);
    return true;
  }

  private scheduleUnload(documentId: string): void {
    const entry = this.entries.get(documentId);
    if (!entry || entry.closing) return;
    this.cancelIdle(entry);
    entry.idleTimer = setTimeout(() => void this.unloadIfIdle(documentId), this.idleMs);
    entry.idleTimer.unref();
  }

  private cancelIdle(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private async unloadIfIdle(documentId: string): Promise<void> {
    const entry = this.entries.get(documentId);
    if (!entry || entry.closing) return;
    const room = await entry.room.catch(() => undefined);
    if (room && room.size === 0) await this.unload(documentId);
  }

  private unload(documentId: string): Promise<void> {
    const entry = this.entries.get(documentId);
    if (!entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    this.cancelIdle(entry);
    entry.closing = (async () => {
      const room = await entry.room.catch(() => undefined);
      try {
        // the store writes what is buffered and compacts the log before the state leaves memory
        await this.store.release(documentId);
      } catch (error) {
        // keep the room (and the store's buffer) and try again later: dropping it would lose the updates
        this.logger.error({ err: error, documentId }, 'releasing a room failed, will retry');
        entry.closing = null;
        if (!this.shuttingDown) this.scheduleUnload(documentId);
        return;
      }
      for (const session of this.matching({ documentIds: [documentId] })) {
        this.sessions.delete(session.conn.id);
      }
      room?.destroy();
      this.entries.delete(documentId);
    })();
    return entry.closing;
  }

  async beforeApplicationShutdown(): Promise<void> {
    // runs before the database and queue connections are closed, so the final flush can still be written
    this.shuttingDown = true;
    const ids = [...this.entries.keys()];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      this.cancelIdle(entry);
      const room = await entry.room.catch(() => undefined);
      room?.closeAll(1001, 'server shutting down');
    }
    await Promise.all(ids.map((id) => this.unload(id)));
    await this.store.close();
  }
}
