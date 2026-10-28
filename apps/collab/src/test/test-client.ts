import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { COLLAB_MESSAGE, type CollabRoomEvent, collabRoomEventSchema } from '@collab-docs/shared';
import type { DocRoom, RoomConnection } from '../rooms/doc-room';

let counter = 0;
const live = new Set<TestClient>();

interface TestClientOptions {
  userId?: string | null;
  name?: string;
  color?: string;
}

/**
 * A browser stand-in speaking the y-websocket protocol to a `DocRoom` through two in-memory queues, so tests
 * can deliver messages late, twice and out of order.
 */
export class TestClient implements RoomConnection {
  readonly id = `conn-${(counter += 1)}`;
  readonly userId: string | null;
  readonly name: string;
  readonly color: string;
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly events: CollabRoomEvent[] = [];
  readonly closed: Array<{ code: number; reason?: string }> = [];
  /** Messages the client wants the server to see. */
  readonly outbox: Uint8Array[] = [];
  /** Messages the server sent. */
  readonly inbox: Uint8Array[] = [];

  constructor(
    private readonly room: DocRoom,
    options: TestClientOptions = {},
  ) {
    this.userId = options.userId === undefined ? `user-${counter}` : options.userId;
    this.name = options.name ?? `User ${counter}`;
    this.color = options.color ?? '#336699';
    live.add(this);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'server') return;
      this.outbox.push(frame(COLLAB_MESSAGE.sync, (e) => syncProtocol.writeUpdate(e, update)));
    });
    this.awareness.on('update', ({ added, updated, removed }: Changes) => {
      const ids = [...added, ...updated, ...removed];
      this.outbox.push(
        frame(COLLAB_MESSAGE.awareness, (e) =>
          encoding.writeVarUint8Array(
            e,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids),
          ),
        ),
      );
    });
  }

  /** Stops the awareness timers of every client created so far (call from `afterEach`). */
  static destroyAll(): void {
    for (const client of live) {
      client.awareness.destroy();
      client.doc.destroy();
    }
    live.clear();
  }

  /** Runs `settle` on all clients until nothing is in flight, since one client's delivery feeds the others. */
  static settleAll(...clients: TestClient[]): void {
    for (let round = 0; round < 10; round += 1) {
      clients.forEach((client) => client.settle());
      if (clients.every((c) => c.outbox.length === 0 && c.inbox.length === 0)) return;
    }
  }

  // RoomConnection ------------------------------------------------------------------------------------
  send(data: Uint8Array): void {
    this.inbox.push(data);
  }

  close(code: number, reason?: string): void {
    this.closed.push({ code, reason });
  }

  // client side ---------------------------------------------------------------------------------------
  /** Joins the room and starts the handshake like y-websocket does (sync step 1 + current awareness). */
  join(access: 'VIEW' | 'EDIT' | 'MANAGE' = 'EDIT'): boolean {
    const admitted = this.room.connect(this, access);
    if (admitted) {
      this.outbox.push(frame(COLLAB_MESSAGE.sync, (e) => syncProtocol.writeSyncStep1(e, this.doc)));
    }
    return admitted;
  }

  /** Delivers everything queued in both directions until both are empty. */
  settle(): void {
    for (
      let guard = 0;
      guard < 100 && (this.outbox.length > 0 || this.inbox.length > 0);
      guard += 1
    ) {
      this.flushOutbox();
      this.flushInbox();
    }
  }

  flushOutbox(order: (messages: Uint8Array[]) => Uint8Array[] = (m) => m): void {
    const messages = order(this.outbox.splice(0));
    for (const message of messages) this.room.receive(this, message);
  }

  flushInbox(order: (messages: Uint8Array[]) => Uint8Array[] = (m) => m): void {
    for (const message of order(this.inbox.splice(0))) this.handleServerMessage(message);
  }

  private handleServerMessage(message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    switch (decoding.readVarUint(decoder)) {
      case COLLAB_MESSAGE.sync: {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, COLLAB_MESSAGE.sync);
        syncProtocol.readSyncMessage(decoder, reply, this.doc, 'server');
        if (encoding.length(reply) > 1) this.outbox.push(encoding.toUint8Array(reply));
        break;
      }
      case COLLAB_MESSAGE.awareness:
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          'server',
        );
        break;
      case COLLAB_MESSAGE.roomEvent:
        this.events.push(collabRoomEventSchema.parse(JSON.parse(decoding.readVarString(decoder))));
        break;
    }
  }

  /** Raw, possibly hostile frame. */
  sendRaw(message: Uint8Array): void {
    this.room.receive(this, message);
  }

  text(): Y.XmlText {
    const fragment = this.doc.getXmlFragment('content');
    if (fragment.length === 0) {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText()]);
      fragment.insert(0, [paragraph]);
    }
    return (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  }

  /** Plain text of the first paragraph. */
  value(): string {
    const fragment = this.doc.getXmlFragment('content');
    const paragraph = fragment.get(0) as Y.XmlElement | undefined;
    return (paragraph?.get(0) as Y.XmlText | undefined)?.toString() ?? '';
  }

  lastEvent<T extends CollabRoomEvent['type']>(
    type: T,
  ): Extract<CollabRoomEvent, { type: T }> | undefined {
    return [...this.events].reverse().find((e) => e.type === type) as never;
  }
}

interface Changes {
  added: number[];
  updated: number[];
  removed: number[];
}

export function frame(type: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}
