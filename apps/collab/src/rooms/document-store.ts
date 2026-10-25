import * as Y from 'yjs';

export const DOCUMENT_STORE = Symbol('DOCUMENT_STORE');

/**
 * Where document state lives. Rooms never talk to the database directly, which keeps the hot path free of
 * I/O: `enqueue` only hands the update over, and the store reports durability through `onPersisted`.
 */
export interface DocumentStore {
  /** The whole stored state as one Yjs update; `null` for a document that was never edited. */
  load(documentId: string): Promise<Uint8Array | null>;

  /** Called for every update applied to a room's document that changed it (never for duplicates). */
  enqueue(documentId: string, update: Uint8Array): void;

  /**
   * Registers a listener for "everything up to this state vector is durable". Returns the unsubscribe
   * function. Called with the state vector of what is stored, after each flush.
   */
  onPersisted(documentId: string, listener: (stateVector: Uint8Array) => void): () => void;

  /** Writes pending updates now (before a room is closed because the document was deleted). */
  flush(documentId: string): Promise<void>;
}

/** Keeps documents in memory: the store for tests, and the default until persistence lands. */
export class InMemoryDocumentStore implements DocumentStore {
  private readonly states = new Map<string, Uint8Array>();
  private readonly listeners = new Map<string, Set<(stateVector: Uint8Array) => void>>();

  load(documentId: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.states.get(documentId) ?? null);
  }

  enqueue(documentId: string, update: Uint8Array): void {
    const previous = this.states.get(documentId);
    const merged = previous ? Y.mergeUpdates([previous, update]) : update;
    this.states.set(documentId, merged);
    const stateVector = Y.encodeStateVectorFromUpdate(merged);
    for (const listener of this.listeners.get(documentId) ?? []) listener(stateVector);
  }

  onPersisted(documentId: string, listener: (stateVector: Uint8Array) => void): () => void {
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

  /** Test helper: the stored document. */
  snapshot(documentId: string): Y.Doc {
    const doc = new Y.Doc();
    const state = this.states.get(documentId);
    if (state) Y.applyUpdate(doc, state);
    return doc;
  }
}
