import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { COLLAB_CLOSE, COLLAB_MESSAGE } from '@collab-docs/shared';
import { DocRoom, type RejectReason, type RoomLimits, type RoomObserver } from './doc-room';
import { type DocumentStore, InMemoryDocumentStore } from './document-store';
import { TestClient, frame } from '../test/test-client';

const LIMITS: RoomLimits = {
  maxMessagesPer10s: 200,
  maxUpdateBytes: 1024 * 1024,
  maxDocumentBytes: 10 * 1024 * 1024,
  maxConnections: 100,
  maxAwarenessBytes: 4096,
};

class Counters implements RoomObserver {
  applied = 0;
  duplicate = 0;
  rejected: RejectReason[] = [];
  limited = 0;
  updateApplied = () => void (this.applied += 1);
  updateDuplicate = () => void (this.duplicate += 1);
  updateRejected = (reason: RejectReason) => void this.rejected.push(reason);
  rateLimited = () => void (this.limited += 1);
}

function setup(limits: Partial<RoomLimits> = {}, initial: Uint8Array | null = null) {
  return setupWith(new InMemoryDocumentStore(), limits, initial);
}

function setupWith<T extends DocumentStore>(
  store: T,
  limits: Partial<RoomLimits> = {},
  initial: Uint8Array | null = null,
) {
  const observer = new Counters();
  const room = new DocRoom('doc-1', initial, store, { ...LIMITS, ...limits }, observer);
  rooms.push(room);
  return { store, observer, room };
}

/**
 * A store whose writes the test acknowledges one at a time, like the real store acknowledges a flush while newer
 * updates keep waiting in its buffer.
 */
class HeldStore implements DocumentStore {
  private readonly durable = new InMemoryDocumentStore();
  private buffered: Array<{ documentId: string; update: Uint8Array; seq: number }> = [];

  load = (documentId: string) => this.durable.load(documentId);

  enqueue(documentId: string, update: Uint8Array, seq: number): void {
    this.buffered.push({ documentId, update, seq });
  }

  onPersisted = (documentId: string, listener: (sv: Uint8Array, seq: number) => void) =>
    this.durable.onPersisted(documentId, listener);

  flush = async (): Promise<void> => this.ackAll();

  release = async (): Promise<void> => this.ackAll();

  close = async (): Promise<void> => this.ackAll();

  ackNext(): boolean {
    const next = this.buffered.shift();
    if (!next) return false;
    this.durable.enqueue(next.documentId, next.update, next.seq);
    return true;
  }

  ackAll(): void {
    let next = this.ackNext();
    while (next) next = this.ackNext();
  }
}

const rooms: DocRoom[] = [];
afterEach(() => {
  rooms.splice(0).forEach((room) => room.destroy());
  TestClient.destroyAll();
});

const shuffle = <T>(items: T[]): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
};

describe('DocRoom', () => {
  describe('sync', () => {
    it('brings a new client up to date and merges what it already has', () => {
      const { room } = setup();
      const first = new TestClient(room);
      first.join();
      first.text().insert(0, 'hello');
      first.settle();

      const second = new TestClient(room);
      second.join();
      second.settle();
      expect(second.value()).toBe('hello');
    });

    it('converges when updates arrive late, duplicated and in any order', () => {
      for (let run = 0; run < 25; run += 1) {
        const { room, store } = setup();
        const a = new TestClient(room);
        const b = new TestClient(room);
        a.join();
        b.join();
        a.text().insert(0, '');
        TestClient.settleAll(a, b);

        a.text().insert(0, 'alpha ');
        b.text().insert(0, 'beta ');
        a.text().insert(a.text().length, 'one');
        b.text().insert(b.text().length, 'two');
        // replay every queued message twice, shuffled
        for (const client of [a, b]) client.outbox.push(...client.outbox);
        for (let round = 0; round < 3; round += 1) {
          a.flushOutbox(shuffle);
          b.flushOutbox(shuffle);
          a.flushInbox(shuffle);
          b.flushInbox(shuffle);
        }
        TestClient.settleAll(a, b);

        expect(a.value()).toBe(b.value());
        expect(room.doc.getXmlFragment('content').toString()).toBe(
          a.doc.getXmlFragment('content').toString(),
        );
        expect(store.snapshot('doc-1').getXmlFragment('content').toString()).toBe(
          a.doc.getXmlFragment('content').toString(),
        );
        for (const word of ['alpha', 'beta', 'one', 'two']) expect(a.value()).toContain(word);
      }
    });

    it('keeps both edits when two clients type into the same paragraph at once', () => {
      const { room } = setup();
      const a = new TestClient(room);
      const b = new TestClient(room);
      a.join();
      a.text().insert(0, 'base');
      a.settle();
      b.join();
      b.settle();
      expect(b.value()).toBe('base');

      a.text().insert(2, 'AAA');
      b.text().insert(2, 'BBB');
      TestClient.settleAll(a, b);

      expect(a.value()).toBe(b.value());
      expect(a.value()).toHaveLength('base'.length + 6);
      expect(a.value()).toContain('AAA');
      expect(a.value()).toContain('BBB');
    });

    it('serves a document loaded from the store (cold start)', () => {
      const source = new Y.Doc();
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('stored text')]);
      source.getXmlFragment('content').insert(0, [paragraph]);
      const { room, observer } = setup({}, Y.encodeStateAsUpdate(source));

      const client = new TestClient(room);
      client.join();
      client.settle();
      expect(client.value()).toBe('stored text');
      // a client that connects with the same content answers with an empty update, which is not an event
      expect(observer.applied + observer.duplicate).toBe(0);
    });
  });

  describe('updates', () => {
    it('does not store or broadcast a duplicate update', () => {
      const { room, store, observer } = setup();
      const writer = new TestClient(room);
      const reader = new TestClient(room);
      writer.join();
      reader.join();
      writer.settle();
      reader.settle();

      writer.text().insert(0, '');
      TestClient.settleAll(writer, reader);
      const enqueue = jest.spyOn(store, 'enqueue');
      writer.text().insert(0, 'once');
      const [update] = writer.outbox;
      TestClient.settleAll(writer, reader);
      expect(enqueue).toHaveBeenCalledTimes(1);

      reader.inbox.length = 0;
      writer.sendRaw(update!);
      writer.sendRaw(update!);
      reader.settle();
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(observer.duplicate).toBe(2);
      expect(reader.inbox).toHaveLength(0);
      expect(reader.value()).toBe('once');
    });

    it('ignores updates from a read-only connection and tells nobody', () => {
      const { room, observer } = setup();
      const editor = new TestClient(room);
      const viewer = new TestClient(room);
      editor.join('EDIT');
      viewer.join('VIEW');
      editor.text().insert(0, 'real');
      editor.settle();
      viewer.settle();
      expect(viewer.value()).toBe('real');
      expect(viewer.lastEvent('access')).toEqual({ type: 'access', level: 'VIEW', readOnly: true });

      viewer.text().insert(0, 'forged ');
      viewer.settle();
      editor.settle();
      expect(observer.rejected).toContain('read_only');
      expect(editor.value()).toBe('real');
      expect(room.doc.getXmlFragment('content').toString()).not.toContain('forged');
    });

    it('rejects oversized and corrupt updates without disturbing the room', () => {
      const { room, observer } = setup({ maxUpdateBytes: 64 });
      const client = new TestClient(room);
      const other = new TestClient(room);
      client.join();
      other.join();
      client.settle();
      other.settle();

      client.text().insert(0, 'x'.repeat(500));
      client.flushOutbox();
      expect(observer.rejected).toEqual(['too_large']);

      client.sendRaw(
        Uint8Array.of(COLLAB_MESSAGE.sync, syncProtocol.messageYjsUpdate, 5, 255, 255, 255, 255, 9),
      );
      client.sendRaw(Uint8Array.of(COLLAB_MESSAGE.sync, 9));
      client.sendRaw(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff));
      client.sendRaw(new Uint8Array());
      expect(observer.rejected.filter((r) => r === 'invalid').length).toBeGreaterThanOrEqual(2);

      // the room still works
      other.text().insert(0, 'ok');
      other.settle();
      expect(room.doc.getXmlFragment('content').toString()).toContain('ok');
    });

    it('does not apply, fan out or persist an update that fails halfway through', () => {
      const { room, observer, store } = setup();
      const sender = new TestClient(room);
      const watcher = new TestClient(room);
      sender.join();
      watcher.join();
      sender.settle();
      watcher.settle();
      const enqueue = jest.spyOn(store, 'enqueue');

      // Yjs applies the structs first and reads the delete set afterwards: cutting the tail makes the update
      // throw only after its content is already in the document
      const source = new Y.Doc();
      const text = new Y.XmlText();
      source.getXmlFragment('content').insert(0, [text]);
      text.insert(0, 'smuggled');
      const update = Y.encodeStateAsUpdate(source);
      sender.sendRaw(
        frame(COLLAB_MESSAGE.sync, (e) => syncProtocol.writeUpdate(e, update.subarray(0, -1))),
      );
      sender.settle();
      watcher.settle();

      expect(observer.rejected).toEqual(['invalid']);
      expect(room.doc.getXmlFragment('content').toString()).not.toContain('smuggled');
      expect(watcher.value()).not.toContain('smuggled');
      expect(enqueue).not.toHaveBeenCalled();
      source.destroy();
    });

    it('refuses updates that would push the document past its size limit', () => {
      const { room, observer } = setup({ maxDocumentBytes: 300 });
      const client = new TestClient(room);
      client.join();
      client.settle();
      client.text().insert(0, 'a'.repeat(100));
      client.settle();
      client.text().insert(0, 'b'.repeat(400));
      client.settle();
      expect(observer.rejected).toContain('document_too_large');
      expect(room.doc.getXmlFragment('content').toString()).not.toContain('b');
    });
  });

  describe('persistence hand-over', () => {
    it('tells clients which state is durable', () => {
      const { room } = setup();
      const client = new TestClient(room);
      client.join();
      client.settle();
      // an empty document is durable from the start
      expect(client.lastEvent('persisted')).toBeDefined();

      client.text().insert(0, 'saved');
      client.settle();
      const persisted = client.lastEvent('persisted');
      const sv = Y.decodeStateVector(Buffer.from(persisted!.sv, 'base64'));
      const local = Y.decodeStateVector(Y.encodeStateVector(client.doc));
      for (const [id, clock] of local) expect(sv.get(id) ?? 0).toBeGreaterThanOrEqual(clock);
    });

    it('sends the durable state to a connection that joins later', () => {
      const { room } = setup();
      const writer = new TestClient(room);
      writer.join();
      writer.text().insert(0, 'abc');
      writer.settle();

      const late = new TestClient(room);
      late.join();
      late.settle();
      const sv = Y.decodeStateVector(Buffer.from(late.lastEvent('persisted')!.sv, 'base64'));
      expect([...sv.values()].some((clock) => clock > 0)).toBe(true);
    });

    it("does not treat the handshake as an acknowledgement of the client's own changes", () => {
      const { room } = setup();
      const client = new TestClient(room);
      client.join();
      client.settle();
      // the room has not seen anything this client holds offline; only a later flush can answer for it
      expect(client.lastEvent('persisted')).toBeDefined();
      expect(client.lastEvent('persisted')).not.toHaveProperty('saved');
    });

    it('answers a repeated update with what is durable, so a reconnecting client stops waiting', () => {
      const { room } = setup();
      const writer = new TestClient(room);
      writer.join();
      writer.settle();
      writer.text().insert(0, 'hello');
      writer.settle();

      const returning = new TestClient(room);
      returning.join();
      returning.settle();
      const before = returning.events.filter((event) => event.type === 'persisted').length;

      // the same update the room already holds, the way a client repeats it after reconnecting
      returning.sendRaw(
        frame(COLLAB_MESSAGE.sync, (encoder) =>
          syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(room.doc)),
        ),
      );
      returning.flushInbox();

      const persisted = returning.events.filter((event) => event.type === 'persisted');
      expect(persisted).toHaveLength(before + 1);
      expect(persisted.at(-1)).toMatchObject({ saved: true });
    });

    it('reports a deletion as unsaved until the store acknowledges it, though the vector never moves', () => {
      const store = new HeldStore();
      const { room } = setupWith(store);
      const client = new TestClient(room);
      client.join();
      client.settle();
      client.text().insert(0, 'hello');
      client.settle();

      const waiting = new TestClient(room);
      waiting.join();
      waiting.settle();
      expect(waiting.lastEvent('persisted')).not.toHaveProperty('saved');

      store.ackAll();
      client.settle();
      waiting.settle();
      expect(client.lastEvent('persisted')).toMatchObject({ saved: true });
      expect(waiting.lastEvent('persisted')).toMatchObject({ saved: true });

      const vector = Y.encodeStateVector(client.doc);
      client.text().delete(0, 'hello'.length);
      client.settle();
      expect(Y.encodeStateVector(client.doc)).toEqual(vector);

      const late = new TestClient(room);
      late.join();
      late.settle();
      expect(late.lastEvent('persisted')).not.toHaveProperty('saved');

      store.ackAll();
      client.settle();
      late.settle();
      expect(client.lastEvent('persisted')).toMatchObject({ saved: true });
      expect(late.lastEvent('persisted')).toMatchObject({ saved: true });
    });

    it('says "not saved" after an acknowledgement that stops short of the newest update', () => {
      const store = new HeldStore();
      const { room } = setupWith(store);
      const client = new TestClient(room);
      client.join();
      client.settle();
      client.text().insert(0, 'a');
      client.settle();

      store.ackNext();
      client.settle();
      client.text().insert(1, 'b');
      client.settle();
      expect(store.ackNext()).toBe(true);
      client.settle();
      expect(client.lastEvent('persisted')).toMatchObject({ saved: false });

      store.ackAll();
      client.settle();
      expect(client.lastEvent('persisted')).toMatchObject({ saved: true });
    });
  });

  describe('presence', () => {
    it('shows the other clients and clears a client that leaves', () => {
      const { room } = setup();
      const a = new TestClient(room, { userId: 'u-a', name: 'Ann' });
      const b = new TestClient(room, { userId: 'u-b', name: 'Bob' });
      a.join();
      b.join();
      a.awareness.setLocalState({
        user: { id: 'u-a', name: 'Ann', color: '#fff' },
        cursor: { anchor: 1 },
      });
      a.settle();
      b.settle();
      expect(b.awareness.getStates().get(a.doc.clientID)).toMatchObject({
        user: { id: 'u-a', name: 'Ann', color: '#336699' },
        cursor: { anchor: 1 },
      });

      room.disconnect(a);
      b.settle();
      expect(b.awareness.getStates().has(a.doc.clientID)).toBe(false);
    });

    it('overwrites a forged identity with the authenticated one', () => {
      const { room } = setup();
      const attacker = new TestClient(room, {
        userId: 'u-real',
        name: 'Real Name',
        color: '#123456',
      });
      const watcher = new TestClient(room);
      attacker.join();
      watcher.join();
      attacker.awareness.setLocalState({
        user: { id: 'admin', name: 'Administrator', color: '#ff0000' },
        cursor: { anchor: 3, head: 3 },
        injected: '<script>',
      });
      attacker.settle();
      watcher.settle();
      expect(watcher.awareness.getStates().get(attacker.doc.clientID)).toEqual({
        user: { id: 'u-real', name: 'Real Name', color: '#123456' },
        cursor: { anchor: 3, head: 3 },
      });
    });

    it('numbers guests one after the other, independent of other rooms', () => {
      const { room } = setup();
      const other = setup().room;
      expect([room.nextGuestName(), room.nextGuestName(), room.nextGuestName()]).toEqual([
        'Guest 1',
        'Guest 2',
        'Guest 3',
      ]);
      expect(other.nextGuestName()).toBe('Guest 1');
    });

    it('lets a guest in with a presence id of its own', () => {
      const { room } = setup();
      const guest = new TestClient(room, { userId: null, name: 'Guest' });
      const watcher = new TestClient(room);
      guest.join();
      watcher.join();
      guest.awareness.setLocalState({ user: { id: 'u-real' } });
      guest.settle();
      watcher.settle();
      const state = watcher.awareness.getStates().get(guest.doc.clientID) as {
        user: { id: string };
      };
      expect(state.user.id).toBe(`guest-${guest.id}`);
    });

    it('does not let a client change or remove another client’s presence', () => {
      const { room } = setup();
      const victim = new TestClient(room, { userId: 'u-victim' });
      const attacker = new TestClient(room, { userId: 'u-attacker' });
      victim.join();
      attacker.join();
      victim.awareness.setLocalState({ user: {} });
      victim.settle();
      attacker.settle();

      const forged = new Y.Doc();
      forged.clientID = victim.doc.clientID;
      const awareness = new awarenessProtocol.Awareness(forged);
      awareness.setLocalState({ user: { id: 'x' }, cursor: 'hijacked' });
      const payload = awarenessProtocol.encodeAwarenessUpdate(awareness, [forged.clientID]);
      awareness.destroy();
      attacker.sendRaw(
        frame(COLLAB_MESSAGE.awareness, (e) => encoding.writeVarUint8Array(e, payload)),
      );
      expect(room.awareness.getStates().get(victim.doc.clientID)).toMatchObject({
        user: { id: 'u-victim' },
      });
      expect(room.awareness.getStates().get(victim.doc.clientID)).not.toHaveProperty('cursor');
    });

    it('drops oversized awareness payloads', () => {
      const { room, observer } = setup({ maxAwarenessBytes: 256 });
      const client = new TestClient(room);
      const watcher = new TestClient(room);
      client.join();
      watcher.join();
      client.awareness.setLocalState({ user: {}, cursor: 'c'.repeat(2000) });
      client.settle();
      watcher.settle();
      expect(observer.rejected).toContain('awareness_invalid');
      expect(watcher.awareness.getStates().has(client.doc.clientID)).toBe(false);
    });
  });

  describe('access changes and limits', () => {
    it('switches a connection to read-only on the fly and announces it', () => {
      const { room, observer } = setup();
      const client = new TestClient(room);
      client.join('EDIT');
      client.text().insert(0, 'before');
      client.settle();

      room.setAccess(client, 'VIEW');
      client.settle();
      expect(client.lastEvent('access')).toEqual({ type: 'access', level: 'VIEW', readOnly: true });
      client.text().insert(0, 'after ');
      client.settle();
      expect(observer.rejected).toContain('read_only');
      expect(room.doc.getXmlFragment('content').toString()).not.toContain('after');

      room.setAccess(client, 'EDIT');
      client.settle();
      expect(client.lastEvent('access')).toEqual({
        type: 'access',
        level: 'EDIT',
        readOnly: false,
      });
    });

    it('closes every connection with the given code after sending the event', () => {
      const { room } = setup();
      const a = new TestClient(room);
      const b = new TestClient(room);
      a.join();
      b.join();
      room.closeAll(COLLAB_CLOSE.deleted, 'deleted', { type: 'deleted' });
      a.settle();
      expect(a.closed).toEqual([{ code: COLLAB_CLOSE.deleted, reason: 'deleted' }]);
      expect(b.closed).toHaveLength(1);
      expect(a.lastEvent('deleted')).toEqual({ type: 'deleted' });
    });

    it('closes a connection that floods the room, once per window', () => {
      let now = 1_000;
      const store = new InMemoryDocumentStore();
      const observer = new Counters();
      const room = new DocRoom(
        'doc-1',
        null,
        store,
        { ...LIMITS, maxMessagesPer10s: 5 },
        observer,
        undefined,
        () => now,
      );
      rooms.push(room);
      const client = new TestClient(room);
      client.join();
      for (let i = 0; i < 20; i += 1) client.sendRaw(Uint8Array.of(COLLAB_MESSAGE.queryAwareness));
      expect(client.closed).toEqual([{ code: COLLAB_CLOSE.rateLimited, reason: 'rate limited' }]);
      expect(observer.limited).toBe(1);

      now += 11_000;
      client.sendRaw(Uint8Array.of(COLLAB_MESSAGE.queryAwareness));
      expect(client.closed).toHaveLength(1);
    });

    it('refuses connections beyond the limit', () => {
      const { room } = setup({ maxConnections: 2 });
      const clients = [new TestClient(room), new TestClient(room), new TestClient(room)];
      expect(clients.map((c) => c.join())).toEqual([true, true, false]);
      expect(clients[2]!.closed[0]?.code).toBe(COLLAB_CLOSE.rateLimited);
      expect(room.size).toBe(2);
    });

    it('reports when the last connection leaves', () => {
      const { room } = setup();
      const onEmpty = jest.fn();
      room.onEmpty = onEmpty;
      const a = new TestClient(room);
      const b = new TestClient(room);
      a.join();
      b.join();
      room.disconnect(a);
      expect(onEmpty).not.toHaveBeenCalled();
      room.disconnect(b);
      expect(onEmpty).toHaveBeenCalledTimes(1);
    });
  });
});
