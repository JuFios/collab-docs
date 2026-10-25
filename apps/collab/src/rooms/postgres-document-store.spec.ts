import * as Y from 'yjs';
import { stateVectorCovers } from '@collab-docs/shared';
import {
  type DocumentStorage,
  type PersistenceHooks,
  type PersistenceObserver,
  PostgresDocumentStore,
} from './postgres-document-store';

const DOC = 'doc-1';

/** A document that records its updates, like a room's Y.Doc; the first `type` also creates the text node. */
function typist() {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  let text: Y.XmlText | null = null;
  return {
    doc,
    type(value: string): Uint8Array {
      doc.transact(() => {
        if (!text) {
          text = new Y.XmlText();
          doc.getXmlFragment('content').insert(0, [text]);
        }
        text.insert(text.length, value);
      });
      return updates[updates.length - 1]!;
    },
  };
}

class FakeStorage implements DocumentStorage {
  rows: Uint8Array[] = [];
  state: Uint8Array | null = null;
  appendCalls = 0;
  compactCalls = 0;
  failAppends = 0;
  failCompact = false;
  failWith: unknown = new Error('database is down');
  skipped = 0;
  revision = 0;
  readCalls = 0;

  read() {
    this.readCalls += 1;
    const parts = [...(this.state ? [this.state] : []), ...this.rows];
    const update = parts.length > 0 ? Y.mergeUpdates(parts) : null;
    return Promise.resolve({
      update,
      stateVector: update
        ? Y.encodeStateVectorFromUpdate(update)
        : Y.encodeStateVector(new Y.Doc()),
      tailRows: this.rows.length,
      tailBytes: this.rows.reduce((total, row) => total + row.byteLength, 0),
      skippedRows: this.skipped,
    });
  }

  append(_documentId: string, update: Uint8Array) {
    this.appendCalls += 1;
    if (this.failAppends > 0) {
      this.failAppends -= 1;
      return Promise.reject(this.failWith);
    }
    this.rows.push(update);
    this.revision += 1;
    return Promise.resolve({ inserted: true, revision: this.revision });
  }

  compact() {
    this.compactCalls += 1;
    if (this.failCompact) return Promise.reject(new Error('compaction failed'));
    const folded = this.rows.length;
    const parts = [...(this.state ? [this.state] : []), ...this.rows];
    this.state = parts.length > 0 ? Y.mergeUpdates(parts) : null;
    this.rows = [];
    return Promise.resolve({ folded, skipped: 0 });
  }
}

function setup(overrides: Partial<ConstructorParameters<typeof PostgresDocumentStore>[1]> = {}) {
  const storage = new FakeStorage();
  const observer = {
    persisted: jest.fn(),
    persistFailed: jest.fn(),
    compacted: jest.fn(),
    compactionFailed: jest.fn(),
    badLogRows: jest.fn(),
  } satisfies PersistenceObserver;
  const hooks = { contentPersisted: jest.fn(), released: jest.fn() } satisfies PersistenceHooks;
  const logger = { warn: jest.fn(), error: jest.fn() };
  const store = new PostgresDocumentStore(
    storage,
    {
      flushIntervalMs: 1000,
      flushMaxWaitMs: 5000,
      compactMaxRows: 100,
      compactMaxBytes: 512 * 1024,
      retryDelaysMs: [1000, 2000, 4000],
      ...overrides,
    },
    observer,
    hooks,
    logger,
  );
  return { storage, observer, hooks, logger, store };
}

const tick = (ms: number) => jest.advanceTimersByTimeAsync(ms);

describe('PostgresDocumentStore', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  describe('write-behind buffer', () => {
    it('merges everything buffered during the quiet period into one row', async () => {
      const { store, storage } = setup();
      const client = typist();
      store.enqueue(DOC, client.type('a'));
      store.enqueue(DOC, client.type('b'));
      store.enqueue(DOC, client.type('c'));
      await tick(999);
      expect(storage.appendCalls).toBe(0);
      await tick(2);
      expect(storage.appendCalls).toBe(1);
      expect(storage.rows).toHaveLength(1);
      const stored = new Y.Doc();
      Y.applyUpdate(stored, storage.rows[0]!);
      expect(stored.getXmlFragment('content').toString()).toBe(
        client.doc.getXmlFragment('content').toString(),
      );
    });

    it('waits for a pause but never longer than the max wait while the document stays busy', async () => {
      const { store, storage } = setup();
      const client = typist();
      // an update every 400 ms keeps resetting the 1 s quiet period
      for (let elapsed = 0; elapsed < 4800; elapsed += 400) {
        store.enqueue(DOC, client.type('x'));
        await tick(400);
      }
      expect(storage.appendCalls).toBe(0);
      await tick(300);
      expect(storage.appendCalls).toBe(1);
      expect(store.pendingCount(DOC)).toBeLessThanOrEqual(1);
    });

    it('does nothing when asked to flush an empty buffer', async () => {
      const { store, storage } = setup();
      await store.flush(DOC);
      store.enqueue(DOC, typist().type('x'));
      await store.flush(DOC);
      await store.flush(DOC);
      expect(storage.appendCalls).toBe(1);
    });

    it('serialises overlapping flushes of one document', async () => {
      const { store, storage } = setup();
      const client = typist();
      let running = 0;
      let overlapped = false;
      const original = storage.append.bind(storage);
      storage.append = async (documentId, update) => {
        running += 1;
        overlapped ||= running > 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        running -= 1;
        return original(documentId, update);
      };
      store.enqueue(DOC, client.type('a'));
      const first = store.flush(DOC);
      await tick(10); // the first write is now in flight
      store.enqueue(DOC, client.type('b'));
      const second = store.flush(DOC);
      await tick(200);
      await Promise.all([first, second]);
      expect(overlapped).toBe(false);
      expect(storage.rows).toHaveLength(2);
    });
  });

  describe('durability', () => {
    it('keeps the buffer when the database fails and writes it later, in order, without loss', async () => {
      const { store, storage, observer } = setup();
      const client = typist();
      storage.failAppends = 2;
      store.enqueue(DOC, client.type('one '));
      await tick(1001); // first attempt fails
      expect(storage.rows).toHaveLength(0);
      expect(store.pendingCount(DOC)).toBe(1);

      store.enqueue(DOC, client.type('two ')); // arrives while the database is down
      await tick(1100); // quiet-period flush: second failure
      expect(storage.rows).toHaveLength(0);

      await tick(5000); // retry timer succeeds
      expect(observer.persistFailed).toHaveBeenCalledTimes(2);
      expect(storage.rows).toHaveLength(1);
      const stored = new Y.Doc();
      Y.applyUpdate(stored, storage.rows[0]!);
      expect(stored.getXmlFragment('content').toString()).toBe(
        client.doc.getXmlFragment('content').toString(),
      );
      expect(store.pendingCount(DOC)).toBe(0);
    });

    it('rejects an explicit flush that fails but keeps the data for the retry', async () => {
      const { store, storage } = setup();
      storage.failAppends = 1;
      store.enqueue(DOC, typist().type('x'));
      await expect(store.flush(DOC)).rejects.toThrow('database is down');
      expect(store.pendingCount(DOC)).toBe(1);
      await tick(1100);
      expect(storage.rows).toHaveLength(1);
    });

    it('drops updates for a document that no longer exists instead of retrying forever', async () => {
      const { store, storage, logger } = setup();
      storage.failAppends = 1;
      storage.failWith = Object.assign(new Error('foreign key'), { code: 'P2003' });
      store.enqueue(DOC, typist().type('x'));
      await tick(1100);
      expect(store.pendingCount(DOC)).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'collab.persist_dropped' }),
        expect.any(String),
      );
      await tick(60_000);
      expect(storage.appendCalls).toBe(1);
    });

    it('announces what is durable, and only after it is written', async () => {
      const { store } = setup();
      const client = typist();
      const seen: Uint8Array[] = [];
      store.onPersisted(DOC, (sv) => seen.push(sv));
      const update = client.type('hello');
      store.enqueue(DOC, update);
      await tick(500);
      expect(seen).toHaveLength(0);
      await tick(600);
      expect(seen).toHaveLength(1);
      expect(stateVectorCovers(seen[0]!, Y.encodeStateVector(client.doc))).toBe(true);

      client.type(' more');
      expect(stateVectorCovers(seen[0]!, Y.encodeStateVector(client.doc))).toBe(false);
    });

    it('does not announce anything for a failed flush', async () => {
      const { store, storage } = setup();
      const listener = jest.fn();
      store.onPersisted(DOC, listener);
      storage.failAppends = 1;
      store.enqueue(DOC, typist().type('x'));
      await store.flush(DOC).catch(() => undefined);
      expect(listener).not.toHaveBeenCalled();
    });

    it('reports the new revision to the hook after each stored write', async () => {
      const { store, hooks } = setup();
      const client = typist();
      store.enqueue(DOC, client.type('a'));
      await store.flush(DOC);
      store.enqueue(DOC, client.type('b'));
      await store.flush(DOC);
      expect(hooks.contentPersisted.mock.calls).toEqual([
        [DOC, 1],
        [DOC, 2],
      ]);
    });

    it('flushes everything on close', async () => {
      const { store, storage } = setup();
      store.enqueue('a', typist().type('1'));
      store.enqueue('b', typist().type('2'));
      await store.close();
      expect(storage.rows).toHaveLength(2);
      await tick(60_000);
      expect(storage.appendCalls).toBe(2);
    });

    it('logs which documents could not be written on close', async () => {
      const { store, storage, logger } = setup();
      storage.failAppends = 1;
      store.enqueue(DOC, typist().type('1'));
      await store.close();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'collab.shutdown_flush_failed', documentId: DOC }),
        expect.any(String),
      );
    });
  });

  describe('loading', () => {
    it('returns the stored document and counts skipped rows', async () => {
      const { store, storage, observer } = setup();
      const client = typist();
      storage.rows.push(client.type('stored'));
      storage.skipped = 2;
      const loaded = await store.load(DOC);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, loaded!);
      expect(doc.getXmlFragment('content').toString()).toContain('stored');
      expect(observer.badLogRows).toHaveBeenCalledWith(2);
    });

    it('returns null for a document without content', async () => {
      const { store } = setup();
      await expect(store.load(DOC)).resolves.toBeNull();
    });

    it('writes updates still buffered before reading, so a reloaded room does not lose them', async () => {
      const { store, storage } = setup();
      store.enqueue(DOC, typist().type('late'));
      const loaded = await store.load(DOC);
      expect(storage.rows).toHaveLength(1);
      expect(loaded).not.toBeNull();
    });
  });

  describe('compaction', () => {
    async function flushMany(store: PostgresDocumentStore, count: number, size = 1) {
      const client = typist();
      for (let i = 0; i < count; i += 1) {
        store.enqueue(DOC, client.type('x'.repeat(size)));
        await store.flush(DOC);
      }
    }

    it('compacts when the log reaches the row threshold, and not before', async () => {
      const { store, storage, observer } = setup();
      await flushMany(store, 99);
      expect(storage.compactCalls).toBe(0);
      await flushMany(store, 1);
      expect(storage.compactCalls).toBe(1);
      expect(storage.rows).toHaveLength(0);
      expect(observer.compacted).toHaveBeenCalledWith(expect.any(Number), 100);
    });

    it('compacts when the log reaches the size threshold', async () => {
      const { store, storage } = setup({ compactMaxBytes: 2000 });
      await flushMany(store, 3, 300);
      expect(storage.compactCalls).toBe(0);
      await flushMany(store, 10, 300);
      expect(storage.compactCalls).toBeGreaterThan(0);
    });

    it('keeps the log bounded under a long editing session (10 000 small updates)', async () => {
      const { store, storage } = setup();
      const client = typist();
      let maxRows = 0;
      for (let i = 0; i < 10_000; i += 1) {
        store.enqueue(DOC, client.type('.'));
        if (i % 10 === 9) {
          await store.flush(DOC);
          maxRows = Math.max(maxRows, storage.rows.length);
        }
      }
      await store.flush(DOC);
      expect(maxRows).toBeLessThanOrEqual(100);
      expect(storage.rows.length).toBeLessThanOrEqual(100);
      // nothing was lost on the way
      const stored = await store.load(DOC);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, stored!);
      expect(doc.getXmlFragment('content').toString()).toBe(
        client.doc.getXmlFragment('content').toString(),
      );
    });

    it('does not fail a successful flush when the compaction fails', async () => {
      const { store, storage, observer } = setup({ compactMaxRows: 2 });
      storage.failCompact = true;
      const client = typist();
      store.enqueue(DOC, client.type('a'));
      await store.flush(DOC);
      store.enqueue(DOC, client.type('b'));
      await expect(store.flush(DOC)).resolves.toBeUndefined();
      expect(observer.compactionFailed).toHaveBeenCalled();
      expect(storage.rows).toHaveLength(2);
    });

    it('compacts when the room is released, then forgets the document', async () => {
      const { store, storage, hooks } = setup();
      store.enqueue(DOC, typist().type('a'));
      await store.release(DOC);
      expect(storage.rows).toHaveLength(0);
      expect(storage.compactCalls).toBe(1);
      expect(hooks.released).toHaveBeenCalledWith(DOC);
      await store.release(DOC);
      expect(storage.compactCalls).toBe(1);
    });

    it('refuses to release a document whose updates could not be written', async () => {
      const { store, storage, hooks } = setup();
      storage.failAppends = 1;
      store.enqueue(DOC, typist().type('a'));
      await expect(store.release(DOC)).rejects.toThrow();
      expect(hooks.released).not.toHaveBeenCalled();
      expect(store.pendingCount(DOC)).toBe(1);
    });
  });
});
