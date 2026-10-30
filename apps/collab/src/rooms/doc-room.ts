import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { CONTENT_FIELD } from '@collab-docs/shared/content';
import {
  type Access,
  COLLAB_CLOSE,
  COLLAB_MESSAGE,
  type CollabRejectReason,
  type CollabRoomEvent,
  accessAtLeast,
} from '@collab-docs/shared';
import {
  type AwarenessEntry,
  decodeAwarenessUpdate,
  encodeAwarenessUpdate,
} from './awareness-codec';
import type { DocumentStore } from './document-store';
import { heldBackViolation, structureViolation } from './update-structure';

/** One WebSocket as the room sees it; the transport (and its tests) provide the implementation. */
export interface RoomConnection {
  readonly id: string;
  /** `null` for a guest holding an EDIT link. */
  readonly userId: string | null;
  readonly name: string;
  readonly color: string;
  /** Correlation id of the request that issued the ticket, for the logs. */
  readonly correlationId?: string;
  send(data: Uint8Array): void;
  close(code: number, reason?: string): void;
}

export interface RoomLimits {
  maxMessagesPer10s: number;
  maxUpdateBytes: number;
  maxDocumentBytes: number;
  maxConnections: number;
  maxAwarenessBytes: number;
  /** Automatic versions: the state before a change is handed to the store at most this often. */
  snapshotIntervalMs: number;
}

export type RejectReason = 'read_only' | 'awareness_invalid' | CollabRejectReason;

export interface RoomObserver {
  updateApplied(): void;
  updateDuplicate(): void;
  updateRejected(reason: RejectReason): void;
  rateLimited(): void;
}

interface RoomLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

const NOOP_OBSERVER: RoomObserver = {
  updateApplied: () => undefined,
  updateDuplicate: () => undefined,
  updateRejected: () => undefined,
  rateLimited: () => undefined,
};

/** Origin of changes the server makes itself; they are broadcast to every connection. */
const SERVER_ORIGIN = 'server';
const RATE_WINDOW_MS = 10_000;
/** A connection normally has one awareness client id (its Y.Doc's); a few spare ones cover provider restarts. */
const MAX_AWARENESS_IDS_PER_CONNECTION = 4;
/** Update of a Y.Doc without structs and deletions. */
const EMPTY_UPDATE_BYTES = 2;
interface ConnectionState {
  readonly conn: RoomConnection;
  access: Access;
  readOnly: boolean;
  /** An update of this connection was refused; its later ones depend on it and are ignored until it reconnects. */
  rejected: boolean;
  /** Closed by the server (`closeAll`, `kick`); a socket that is still closing may deliver messages, which change nothing. */
  closing: boolean;
  /** Awareness client ids this connection owns; it may only change those. */
  readonly awarenessIds: Set<number>;
  windowStart: number;
  messages: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function frame(type: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

/**
 * The live state of one document: its `Y.Doc`, the connections editing it and their presence. Pure in the
 * sense that matters for the hot path: it performs no I/O, it only calls the `DocumentStore` hand-over.
 */
export class DocRoom {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** Called when the last connection leaves; the manager schedules the unload. */
  onEmpty: (() => void) | null = null;

  private readonly connections = new Map<string, ConnectionState>();
  /** Awareness client id → owner; `null` reserves the server's own id. */
  private readonly awarenessOwners = new Map<number, ConnectionState | null>();
  private guestSequence = 0;
  private persistedStateVector: Uint8Array;
  /** The last update the room handed to the store; every update gets the next number. */
  private lastSubmittedSeq = 0;
  /** The last of those the store has written. */
  private persistedSeq = 0;
  /** Encoded size of the document when it was last measured (or loaded). */
  private measuredBytes: number;
  /**
   * Bytes of the updates applied since then. Their sum only grows, deletions included, so together with
   * `measuredBytes` it is an upper bound that is measured again before it may refuse an update.
   */
  private unmeasuredBytes = 0;
  private appliedChange = false;
  /** When the state before a change was last handed over for an automatic version (`-Infinity`: never). */
  private lastSnapshotOffer = Number.NEGATIVE_INFINITY;
  private readonly unsubscribe: () => void;
  private destroyed = false;

  constructor(
    readonly documentId: string,
    initialState: Uint8Array | null,
    private readonly store: DocumentStore,
    private readonly limits: RoomLimits,
    private readonly observer: RoomObserver = NOOP_OBSERVER,
    private readonly logger: RoomLogger = { warn: () => undefined },
    private readonly clock: () => number = Date.now,
  ) {
    if (initialState) Y.applyUpdate(this.doc, initialState, 'load');
    this.measuredBytes = initialState?.byteLength ?? 0;
    // everything loaded from the store is durable by definition
    this.persistedStateVector = Y.encodeStateVector(this.doc);
    this.awareness.setLocalState(null);
    this.awarenessOwners.set(this.doc.clientID, null);

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    this.unsubscribe = store.onPersisted(documentId, this.onPersisted);
  }

  /** Presence name of the next guest who joins with an edit link: `Guest 1`, `Guest 2`, … for as long as the room lives. */
  nextGuestName(): string {
    return `Guest ${++this.guestSequence}`;
  }

  get size(): number {
    return this.connections.size;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** The connections currently in the room. */
  members(): RoomConnection[] {
    return [...this.connections.values()].map((state) => state.conn);
  }

  /** Admits a connection; returns `false` (after closing it) when the room is full. */
  connect(conn: RoomConnection, access: Access): boolean {
    if (this.connections.size >= this.limits.maxConnections) {
      conn.close(COLLAB_CLOSE.rateLimited, 'too many connections');
      return false;
    }
    const state: ConnectionState = {
      conn,
      access,
      readOnly: !accessAtLeast(access, 'EDIT'),
      rejected: false,
      closing: false,
      awarenessIds: new Set(),
      windowStart: this.clock(),
      messages: 0,
    };
    this.connections.set(conn.id, state);

    this.send(
      state,
      frame(COLLAB_MESSAGE.sync, (encoder) => syncProtocol.writeSyncStep1(encoder, this.doc)),
    );
    const present = [...this.awareness.getStates().keys()];
    if (present.length > 0) {
      this.send(
        state,
        frame(COLLAB_MESSAGE.awareness, (encoder) =>
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, present),
          ),
        ),
      );
    }
    this.sendEvent(state, { type: 'access', level: access, readOnly: state.readOnly });
    // the handshake says what is durable, not what the client has: its offline changes have not arrived yet
    this.sendEvent(state, { type: 'persisted', sv: toBase64(this.persistedStateVector) });
    return true;
  }

  disconnect(conn: RoomConnection): void {
    const state = this.connections.get(conn.id);
    if (!state) return;
    this.connections.delete(conn.id);
    const ids = [...state.awarenessIds];
    for (const id of ids) this.awarenessOwners.delete(id);
    // removes the presence of the departed client and tells everyone else
    awarenessProtocol.removeAwarenessStates(this.awareness, ids, null);
    if (this.connections.size === 0) this.onEmpty?.();
  }

  /** Access level the connection currently has (`NONE` if it is not in the room). */
  accessOf(conn: RoomConnection): Access {
    return this.connections.get(conn.id)?.access ?? 'NONE';
  }

  /** Applies a changed permission to a live connection: read-only or not, and tells the client. */
  setAccess(conn: RoomConnection, access: Access): void {
    const state = this.connections.get(conn.id);
    if (!state || state.access === access) return;
    state.access = access;
    state.readOnly = !accessAtLeast(access, 'EDIT');
    this.sendEvent(state, { type: 'access', level: access, readOnly: state.readOnly });
  }

  /** Sends `event` (if any) to every connection and closes them with `code`. */
  closeAll(code: number, reason: string, event?: CollabRoomEvent): void {
    for (const state of [...this.connections.values()]) {
      state.closing = true;
      if (event) this.sendEvent(state, event);
      state.conn.close(code, reason);
    }
  }

  /**
   * Replaces the body with a copy of `source`'s, as a single transaction by the server (restore of a version).
   * Connected clients receive it like any other update and converge on it.
   */
  replaceContent(source: Y.Doc): void {
    this.doc.transact(() => {
      const fragment = this.doc.getXmlFragment(CONTENT_FIELD);
      fragment.delete(0, fragment.length);
      fragment.insert(
        0,
        source
          .getXmlFragment(CONTENT_FIELD)
          .toArray()
          .filter((node): node is Y.XmlElement | Y.XmlText => !(node instanceof Y.XmlHook))
          .map((node) => node.clone()),
      );
    }, SERVER_ORIGIN);
  }

  /** Sends `event` (if any) to one connection and closes it with `code`. */
  kick(conn: RoomConnection, code: number, reason: string, event?: CollabRoomEvent): void {
    const state = this.connections.get(conn.id);
    if (!state) return;
    state.closing = true;
    if (event) this.sendEvent(state, event);
    conn.close(code, reason);
  }

  /** Processes one binary message from `conn`. Never throws: a hostile client must not take the room down. */
  receive(conn: RoomConnection, data: Uint8Array): void {
    const state = this.connections.get(conn.id);
    if (!state || state.closing || !this.allowMessage(state)) return;
    try {
      const decoder = decoding.createDecoder(data);
      switch (decoding.readVarUint(decoder)) {
        case COLLAB_MESSAGE.sync:
          this.handleSync(state, decoder);
          break;
        case COLLAB_MESSAGE.awareness:
          this.handleAwareness(state, decoding.readVarUint8Array(decoder));
          break;
        case COLLAB_MESSAGE.queryAwareness:
          this.sendAllAwareness(state);
          break;
        default:
          // auth (2) and unknown types carry nothing the server acts on
          break;
      }
    } catch (error) {
      this.reject(state, 'invalid', error);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.awareness.destroy();
    this.doc.destroy();
    this.connections.clear();
    this.awarenessOwners.clear();
  }

  // --- message handling -------------------------------------------------------------------------------

  private allowMessage(state: ConnectionState): boolean {
    const now = this.clock();
    if (now - state.windowStart >= RATE_WINDOW_MS) {
      state.windowStart = now;
      state.messages = 0;
    }
    state.messages += 1;
    if (state.messages <= this.limits.maxMessagesPer10s) return true;
    if (state.messages === this.limits.maxMessagesPer10s + 1) {
      this.observer.rateLimited();
      // what it still sends while closing, even in a later window, changes nothing
      state.closing = true;
      state.conn.close(COLLAB_CLOSE.rateLimited, 'rate limited');
    }
    return false;
  }

  private handleSync(state: ConnectionState, decoder: decoding.Decoder): void {
    switch (decoding.readVarUint(decoder)) {
      case syncProtocol.messageYjsSyncStep1:
        this.send(
          state,
          frame(COLLAB_MESSAGE.sync, (encoder) =>
            syncProtocol.readSyncStep1(decoder, encoder, this.doc),
          ),
        );
        break;
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate:
        this.applyClientUpdate(state, decoding.readVarUint8Array(decoder));
        break;
      default:
        throw new Error('unknown sync message');
    }
  }

  private applyClientUpdate(state: ConnectionState, update: Uint8Array): void {
    // a client answering our sync step 1 with nothing to add sends an empty update; that is not an event
    if (update.byteLength <= EMPTY_UPDATE_BYTES) return;
    if (state.readOnly) return this.reject(state, 'read_only');
    // the client starts over after a rejection; until then everything it sends builds on the refused update
    if (state.rejected) return;
    if (update.byteLength > this.limits.maxUpdateBytes) return this.refuse(state, 'too_large');
    if (!this.fitsDocument(update.byteLength)) return this.refuse(state, 'document_too_large');
    this.appliedChange = false;
    try {
      // structs are integrated before the delete set is read, so a throw from applyUpdate can come too late:
      // decode first, or an update called "rejected" has already changed the document
      const decoded = Y.decodeUpdate(update);
      const violation = structureViolation(decoded, this.doc);
      if (violation) {
        return this.refuse(state, 'invalid', new Error(`outside the content model: ${violation}`));
      }
      // changes held back until now are integrated with this one, so they are checked against it
      const heldViolation = heldBackViolation(decoded, this.doc);
      if (heldViolation) this.dropHeldBack(heldViolation);
      // the version keeps what the change replaces; encoded only when one may be due, not on every keystroke
      const now = this.clock();
      const before =
        now - this.lastSnapshotOffer >= this.limits.snapshotIntervalMs
          ? Y.encodeStateAsUpdate(this.doc)
          : null;
      Y.applyUpdate(this.doc, update, state);
      if (before && this.appliedChange) {
        this.lastSnapshotOffer = now;
        this.store.changeStarting(this.documentId, before);
      }
    } catch (error) {
      // a throw after the update was integrated (from an observer) leaves it in the room: it was not refused
      return this.appliedChange
        ? this.reject(state, 'invalid', error)
        : this.refuse(state, 'invalid', error);
    }
    if (this.pendingBytes() > this.limits.maxUpdateBytes) {
      // updates whose dependencies never arrive would pile up in memory, unpersisted and outside the size check
      this.doc.store.pendingStructs = null;
      this.doc.store.pendingDs = null;
      return this.refuse(state, 'too_large');
    }
    if (this.appliedChange) this.observer.updateApplied();
    else {
      this.observer.updateDuplicate();
      // a client repeats what it holds after reconnecting; answering says whether that is stored or still pending
      this.sendEvent(state, this.persistedEvent());
    }
  }

  /**
   * Discards the changes Yjs holds back, because one of them does not fit the content model. This sender is not at
   * fault: its update only supplied what they waited for (anyone can build a change on the next id of another
   * client), so it is applied as usual and nobody is told, as the author of the held-back change is not known.
   */
  private dropHeldBack(violation: string): void {
    this.doc.store.pendingStructs = null;
    this.doc.store.pendingDs = null;
    this.observer.updateRejected('invalid');
    this.logger.warn(
      {
        event: 'collab.update_rejected',
        reason: 'invalid',
        documentId: this.documentId,
        err: `held-back change outside the content model: ${violation}`,
      },
      'collab.update_rejected',
    );
  }

  /** Would the document stay within its size limit with `bytes` more? */
  private fitsDocument(bytes: number): boolean {
    const limit = this.limits.maxDocumentBytes;
    // held-back updates join the document as soon as what they wait for arrives, so they count already
    const held = this.pendingBytes();
    if (this.measuredBytes + this.unmeasuredBytes + held + bytes <= limit) return true;
    // only applied updates make the estimate drift, so a document that really is full is encoded once, not per refusal
    if (this.unmeasuredBytes > 0) {
      this.measuredBytes = Y.encodeStateAsUpdate(this.doc).byteLength;
      this.unmeasuredBytes = 0;
    }
    return this.measuredBytes + this.unmeasuredBytes + held + bytes <= limit;
  }

  /** Bytes Yjs holds back because they depend on changes the room has not received (they emit no `update`). */
  private pendingBytes(): number {
    const { pendingStructs, pendingDs } = this.doc.store;
    return (pendingStructs?.update.byteLength ?? 0) + (pendingDs?.byteLength ?? 0);
  }

  private handleAwareness(state: ConnectionState, payload: Uint8Array): void {
    if (payload.byteLength > this.limits.maxAwarenessBytes) {
      return this.reject(state, 'awareness_invalid');
    }
    let entries: AwarenessEntry[];
    try {
      entries = decodeAwarenessUpdate(payload);
    } catch (error) {
      return this.reject(state, 'awareness_invalid', error);
    }
    const accepted: AwarenessEntry[] = [];
    for (const entry of entries) {
      if (!this.claimAwarenessId(state, entry.clientId)) continue;
      if (entry.state === null) {
        accepted.push(entry);
      } else if (isRecord(entry.state)) {
        accepted.push({ ...entry, state: this.presenceOf(state, entry.state) });
      }
    }
    if (accepted.length === 0) return;
    awarenessProtocol.applyAwarenessUpdate(this.awareness, encodeAwarenessUpdate(accepted), state);
  }

  /** The server decides who a cursor belongs to; only the cursor position comes from the client. */
  private presenceOf(
    state: ConnectionState,
    sent: Record<string, unknown>,
  ): Record<string, unknown> {
    const { conn } = state;
    const presence: Record<string, unknown> = {
      user: { id: conn.userId ?? `guest-${conn.id}`, name: conn.name, color: conn.color },
    };
    const cursor = sent.cursor;
    if (cursor !== undefined && JSON.stringify(cursor).length <= this.limits.maxAwarenessBytes) {
      presence.cursor = cursor;
    }
    return presence;
  }

  private claimAwarenessId(state: ConnectionState, clientId: number): boolean {
    if (state.awarenessIds.has(clientId)) return true;
    if (this.awarenessOwners.has(clientId)) return false;
    if (state.awarenessIds.size >= MAX_AWARENESS_IDS_PER_CONNECTION) return false;
    state.awarenessIds.add(clientId);
    this.awarenessOwners.set(clientId, state);
    return true;
  }

  private reject(state: ConnectionState, reason: RejectReason, error?: unknown): void {
    this.observer.updateRejected(reason);
    this.logger.warn(
      {
        event: 'collab.update_rejected',
        reason,
        documentId: this.documentId,
        connectionId: state.conn.id,
        userId: state.conn.userId,
        correlationId: state.conn.correlationId,
        err: error instanceof Error ? error.message : undefined,
      },
      'collab.update_rejected',
    );
  }

  /**
   * Refuses an update of `state` before it reached the room. The refused change stays in the client's own document and
   * everything it sends later builds on it, so it is told once and its later updates are ignored until it reconnects.
   */
  private refuse(state: ConnectionState, reason: CollabRejectReason, error?: unknown): void {
    this.reject(state, reason, error);
    if (state.rejected) return;
    state.rejected = true;
    this.sendEvent(state, { type: 'rejected', reason });
  }

  // --- fan-out ----------------------------------------------------------------------------------------

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    this.appliedChange = true;
    this.unmeasuredBytes += update.byteLength;
    const message = frame(COLLAB_MESSAGE.sync, (encoder) =>
      syncProtocol.writeUpdate(encoder, update),
    );
    for (const state of this.connections.values()) {
      if (state !== origin) this.send(state, message);
    }
    this.lastSubmittedSeq += 1;
    this.store.enqueue(this.documentId, update, this.lastSubmittedSeq);
  };

  private readonly onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    void origin;
    const changed = [...change.added, ...change.updated, ...change.removed];
    if (changed.length === 0) return;
    const message = frame(COLLAB_MESSAGE.awareness, (encoder) =>
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      ),
    );
    for (const state of this.connections.values()) this.send(state, message);
  };

  private readonly onPersisted = (stateVector: Uint8Array, persistedSeq: number): void => {
    this.persistedStateVector = stateVector;
    this.persistedSeq = persistedSeq;
    const event = this.persistedEvent();
    for (const state of this.connections.values()) this.sendEvent(state, event);
  };

  /** What is durable, and whether that covers every update the room received: a vector cannot show a deletion. */
  private persistedEvent(): CollabRoomEvent {
    return {
      type: 'persisted',
      sv: toBase64(this.persistedStateVector),
      saved: this.lastSubmittedSeq <= this.persistedSeq,
    };
  }

  private sendAllAwareness(state: ConnectionState): void {
    const ids = [...this.awareness.getStates().keys()];
    if (ids.length === 0) return;
    this.send(
      state,
      frame(COLLAB_MESSAGE.awareness, (encoder) =>
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids),
        ),
      ),
    );
  }

  private sendEvent(state: ConnectionState, event: CollabRoomEvent): void {
    this.send(
      state,
      frame(COLLAB_MESSAGE.roomEvent, (encoder) =>
        encoding.writeVarString(encoder, JSON.stringify(event)),
      ),
    );
  }

  private send(state: ConnectionState, message: Uint8Array): void {
    try {
      state.conn.send(message);
    } catch {
      // a socket that cannot be written to is closed by the transport; the room keeps serving the others
    }
  }
}
