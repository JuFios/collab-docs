import * as Y from 'yjs';
import type { DocumentStore } from './document-store';
import { advanceStateVector } from './state-vector';

/** What the store needs from the database layer; `@collab-docs/db` provides it, tests replace it. */
export interface DocumentStorage {
  read(documentId: string): Promise<{
    update: Uint8Array | null;
    stateVector: Uint8Array;
    tailRows: number;
    tailBytes: number;
    skippedRows: number;
  }>;
  append(documentId: string, update: Uint8Array): Promise<{ inserted: boolean; revision: number }>;
  compact(documentId: string): Promise<{ folded: number; skipped: number }>;
}

export interface PersistenceObserver {
  persisted(seconds: number): void;
  persistFailed(): void;
  compacted(seconds: number, rows: number): void;
  compactionFailed(): void;
  badLogRows(count: number): void;
}

/** Things that happen after a successful write; both are fire-and-forget and must never fail a flush. */
export interface PersistenceHooks {
  /** Called after the commit that stored new content, with the new `documents.revision`. */
  contentPersisted(documentId: string, revision: number): void;
  /** The document's in-memory bookkeeping is dropped. */
  released(documentId: string): void;
  /** Resolves when the work started by `contentPersisted` is done; called at shutdown, before connections close. */
  drain(): Promise<void>;
}

interface PersistenceLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

interface PersistenceOptions {
  /** Quiet period after the last update before a flush. */
  flushIntervalMs: number;
  /** A flush happens at the latest this long after the first buffered update, however busy the document is. */
  flushMaxWaitMs: number;
  compactMaxRows: number;
  compactMaxBytes: number;
  /** Delays between retries of a failed flush; the last one repeats. */
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const;

/** Foreign-key and missing-row errors cannot be fixed by retrying (the document is gone). */
const PERMANENT_ERROR_CODES = new Set(['P2003', 'P2025']);

interface PendingUpdate {
  update: Uint8Array;
  seq: number;
}

interface DocumentState {
  pending: PendingUpdate[];
  firstPendingAt: number | null;
  debounceTimer: NodeJS.Timeout | null;
  maxWaitTimer: NodeJS.Timeout | null;
  retryTimer: NodeJS.Timeout | null;
  retryAttempt: number;
  /** Writes of one document run one after another. */
  chain: Promise<void>;
  /** What is durable: the loaded state plus every flush since. */
  persistedStateVector: Uint8Array;
  /** Sequence number of the last update in `persistedStateVector`. */
  persistedSeq: number;
  tailRows: number;
  tailBytes: number;
}

/**
 * Write-behind persistence (spec §5, P13). Updates arrive synchronously from the rooms and are buffered per
 * document; a flush merges the buffer into one row (`Y.mergeUpdates`) and writes it together with the
 * revision bump. A failed flush keeps the buffer and retries with backoff, so the database being down for a
 * while loses nothing as long as the process lives (and clients re-send what the server never acknowledged
 * if it does not: see the README on the loss window).
 */
export class PostgresDocumentStore implements DocumentStore {
  private readonly states = new Map<string, DocumentState>();
  private readonly listeners = new Map<
    string,
    Set<(stateVector: Uint8Array, persistedSeq: number) => void>
  >();
  private closed = false;

  constructor(
    private readonly storage: DocumentStorage,
    private readonly options: PersistenceOptions,
    private readonly observer: PersistenceObserver,
    private readonly hooks: PersistenceHooks,
    private readonly logger: PersistenceLogger,
    private readonly clock: () => number = Date.now,
  ) {}

  async load(documentId: string): Promise<Uint8Array | null> {
    const state = this.stateOf(documentId);
    // a room that was unloaded with unwritten updates must not come back without them
    if (state.pending.length > 0) await this.flush(documentId);
    const stored = await this.storage.read(documentId);
    if (stored.skippedRows > 0) {
      this.observer.badLogRows(stored.skippedRows);
      this.logger.warn(
        { event: 'collab.bad_log_rows', documentId, rows: stored.skippedRows },
        'skipped undecodable update-log rows',
      );
    }
    state.persistedStateVector = stored.stateVector;
    state.tailRows = stored.tailRows;
    state.tailBytes = stored.tailBytes;
    return stored.update;
  }

  enqueue(documentId: string, update: Uint8Array, seq: number): void {
    const state = this.stateOf(documentId);
    state.pending.push({ update, seq });
    if (state.firstPendingAt === null) {
      state.firstPendingAt = this.clock();
      state.maxWaitTimer = this.timer(
        () => void this.flushQuietly(documentId),
        this.options.flushMaxWaitMs,
      );
    }
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = this.timer(
      () => void this.flushQuietly(documentId),
      this.options.flushIntervalMs,
    );
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

  flush(documentId: string): Promise<void> {
    const state = this.states.get(documentId);
    if (!state) return Promise.resolve();
    const run = state.chain.then(() => this.writePending(documentId, state));
    state.chain = run.catch(() => undefined);
    return run;
  }

  async release(documentId: string): Promise<void> {
    const state = this.states.get(documentId);
    if (!state) return;
    await this.flush(documentId);
    if (state.tailRows > 0) await this.compact(documentId, state);
    this.clearTimers(state);
    this.states.delete(documentId);
    this.hooks.released(documentId);
  }

  async close(): Promise<void> {
    this.closed = true;
    const ids = [...this.states.keys()];
    const results = await Promise.allSettled(ids.map((id) => this.flush(id)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(
          {
            event: 'collab.shutdown_flush_failed',
            documentId: ids[index],
            err: String(result.reason),
          },
          'updates could not be written before shutdown',
        );
      }
    });
    for (const state of this.states.values()) this.clearTimers(state);
    await this.hooks.drain();
  }

  /** Updates buffered but not yet written (metrics, tests). */
  pendingCount(documentId: string): number {
    return this.states.get(documentId)?.pending.length ?? 0;
  }

  // --- internals ----------------------------------------------------------------------------------------

  private stateOf(documentId: string): DocumentState {
    let state = this.states.get(documentId);
    if (!state) {
      state = {
        pending: [],
        firstPendingAt: null,
        debounceTimer: null,
        maxWaitTimer: null,
        retryTimer: null,
        retryAttempt: 0,
        chain: Promise.resolve(),
        persistedStateVector: Y.encodeStateVector(new Y.Doc()),
        persistedSeq: 0,
        tailRows: 0,
        tailBytes: 0,
      };
      this.states.set(documentId, state);
    }
    return state;
  }

  private timer(callback: () => void, ms: number): NodeJS.Timeout {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  }

  private clearTimers(state: DocumentState): void {
    for (const key of ['debounceTimer', 'maxWaitTimer', 'retryTimer'] as const) {
      const handle = state[key];
      if (handle) clearTimeout(handle);
      state[key] = null;
    }
  }

  /** Timer-driven flush: failures are already logged and rescheduled, so nobody awaits the result. */
  private async flushQuietly(documentId: string): Promise<void> {
    await this.flush(documentId).catch(() => undefined);
  }

  private async writePending(documentId: string, state: DocumentState): Promise<void> {
    this.clearTimers(state);
    state.firstPendingAt = null;
    if (state.pending.length === 0) return;

    const batch = state.pending.splice(0);
    const merged =
      batch.length === 1
        ? batch[0]!.update
        : Y.mergeUpdates(batch.map((pending) => pending.update));
    const lastSeq = batch[batch.length - 1]!.seq;
    const startedAt = this.clock();
    let result: { inserted: boolean; revision: number };
    try {
      result = await this.storage.append(documentId, merged);
    } catch (error) {
      this.observer.persistFailed();
      if (PERMANENT_ERROR_CODES.has((error as { code?: string }).code ?? '')) {
        this.logger.error(
          { event: 'collab.persist_dropped', documentId, err: String(error) },
          'updates dropped: the document no longer exists',
        );
        return;
      }
      // keep the data, in order: the failed batch goes back in front of whatever arrived meanwhile
      state.pending.unshift({ update: merged, seq: lastSeq });
      state.firstPendingAt ??= this.clock();
      this.scheduleRetry(documentId, state);
      this.logger.warn(
        {
          event: 'collab.persist_failed',
          documentId,
          attempt: state.retryAttempt,
          err: String(error),
        },
        'flush failed, will retry',
      );
      throw error;
    }
    this.observer.persisted((this.clock() - startedAt) / 1000);
    state.retryAttempt = 0;
    state.persistedStateVector = advanceStateVector(state.persistedStateVector, merged);
    state.persistedSeq = lastSeq;
    if (result.inserted) {
      state.tailRows += 1;
      state.tailBytes += merged.byteLength;
    }
    for (const listener of this.listeners.get(documentId) ?? [])
      listener(state.persistedStateVector, state.persistedSeq);
    if (result.inserted) this.hooks.contentPersisted(documentId, result.revision);
    if (
      state.tailRows >= this.options.compactMaxRows ||
      state.tailBytes >= this.options.compactMaxBytes
    ) {
      await this.compact(documentId, state);
    }
  }

  private scheduleRetry(documentId: string, state: DocumentState): void {
    if (this.closed) return;
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const delay = delays[Math.min(state.retryAttempt, delays.length - 1)]!;
    state.retryAttempt += 1;
    state.retryTimer = this.timer(() => void this.flushQuietly(documentId), delay);
  }

  /** Compaction failing is not a reason to fail a flush that did succeed: the log just keeps its rows. */
  private async compact(documentId: string, state: DocumentState): Promise<void> {
    const startedAt = this.clock();
    try {
      const { folded } = await this.storage.compact(documentId);
      this.observer.compacted((this.clock() - startedAt) / 1000, folded);
      state.tailRows = 0;
      state.tailBytes = 0;
    } catch (error) {
      this.observer.compactionFailed();
      this.logger.warn(
        { event: 'collab.compaction_failed', documentId, err: String(error) },
        'compaction failed',
      );
    }
  }
}
