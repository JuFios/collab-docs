import * as Y from 'yjs';

export const DOCUMENT_STORE = Symbol('DOCUMENT_STORE');

/**
 * Where document state lives. Rooms never talk to the database directly, which keeps the hot path free of
 * I/O: `enqueue` only hands the update over, and the store reports durability through `onPersisted`.
 */
export interface DocumentStore {
  /** The whole stored state as one Yjs update; `null` for a document that was never edited. */
  load(documentId: string): Promise<Uint8Array | null>;

  /**
   * Called for every update applied to a room's document that changed it (never for duplicates). `seq` counts
   * the updates the room submitted, in order: a state vector cannot show a deletion, so the sequence is what
   * tells a client that a deletion is durable.
   */
  enqueue(documentId: string, update: Uint8Array, seq: number): void;

  /**
   * The document as it was just before a change, handed over at most once per snapshot interval (the first change
   * after a pause): the automatic version keeps the state the change replaced, not the one it produced.
   */
  changeStarting(documentId: string, stateBefore: Uint8Array): void;

  /**
   * Registers a listener for "everything up to `persistedSeq` is durable". Returns the unsubscribe function.
   * Called with the state vector of what is stored and the sequence number of the last update it covers, after
   * each flush.
   */
  onPersisted(
    documentId: string,
    listener: (stateVector: Uint8Array, persistedSeq: number) => void,
  ): () => void;

  /**
   * Writes pending updates now and resolves once they are durable; rejects if they could not be written (they
   * stay buffered and are retried). Used before a room is closed, before a version is taken, before publishing.
   */
  flush(documentId: string): Promise<void>;

  /** The room is going away: flush, compact the log and drop the document's in-memory bookkeeping. */
  release(documentId: string): Promise<void>;

  /** Process shutdown: flush everything that is buffered. */
  close(): Promise<void>;
}

/** Keeps documents in memory: the store for tests, and the default until persistence lands. */
export class InMemoryDocumentStore implements DocumentStore {
  private readonly states = new Map<string, Uint8Array>();
  private readonly listeners = new Map<
    string,
    Set<(stateVector: Uint8Array, persistedSeq: number) => void>
  >();

  load(documentId: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.states.get(documentId) ?? null);
  }

  enqueue(documentId: string, update: Uint8Array, seq: number): void {
    const previous = this.states.get(documentId);
    const merged = previous ? Y.mergeUpdates([previous, update]) : update;
    this.states.set(documentId, merged);
    const stateVector = Y.encodeStateVectorFromUpdate(merged);
    for (const listener of this.listeners.get(documentId) ?? []) listener(stateVector, seq);
  }

  changeStarting(): void {
    // nothing to version in memory
  }

  onPersisted(
    documentId: string,
    listener: (stateVector: Uint8Array, persistedSeq: number) => void,
  ): () => void {
    const set = this.listeners.get(documentId) ?? new Set();
    set.add(listener);
    this.listeners.set(documentId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(documentId);
    };
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  release(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Test helper: the stored document. */
  snapshot(documentId: string): Y.Doc {
    const doc = new Y.Doc();
    const state = this.states.get(documentId);
    if (state) Y.applyUpdate(doc, state);
    return doc;
  }
}
