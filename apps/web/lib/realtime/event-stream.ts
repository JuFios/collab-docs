import { type WorkspaceEvent, WORKSPACE_EVENT_TYPES, parseWorkspaceEvent } from './events';

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'offline';

export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

interface EventStreamOptions {
  url: string;
  onEvent: (event: WorkspaceEvent) => void;
  onStatus: (status: StreamStatus) => void;
  /** Called when the stream is back after an interruption: events in between were lost, so refetch. */
  onResync: () => void;
  /** Renews the session when the browser gave up on the stream (a 401 closes an EventSource for good). */
  refreshSession: () => Promise<unknown>;
  createSource?: (url: string) => EventSourceLike;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const CLOSED = 2;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * One SSE connection with reconnects. The browser retries on its own while the connection merely drops; when it
 * gives up (readyState CLOSED, e.g. after a 401), this renews the session and opens a new source with backoff.
 */
export function openEventStream(options: EventStreamOptions): () => void {
  const create = options.createSource ?? ((url) => new EventSource(url));
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number));

  let source: EventSourceLike | undefined;
  let timer: unknown;
  let stopped = false;
  let interrupted = false;
  let backoff = MIN_BACKOFF_MS;

  const connect = () => {
    if (stopped) return;
    const current = create(options.url);
    source = current;
    current.onopen = () => {
      if (stopped || source !== current) return;
      backoff = MIN_BACKOFF_MS;
      options.onStatus('open');
      if (interrupted) {
        interrupted = false;
        options.onResync();
      }
    };
    for (const type of WORKSPACE_EVENT_TYPES) {
      current.addEventListener(type, (message) => {
        if (stopped || source !== current) return;
        const event = parseWorkspaceEvent(type, message.data);
        if (event) options.onEvent(event);
      });
    }
    current.onerror = () => {
      if (stopped || source !== current) return;
      interrupted = true;
      options.onStatus('reconnecting');
      if (current.readyState !== CLOSED) return; // the browser is already retrying
      current.close();
      void options
        .refreshSession()
        .then(
          () => true,
          () => false,
        )
        .then((renewed) => {
          if (stopped) return;
          if (!renewed) {
            // the next api call sends the user to the login page; nothing to retry here
            options.onStatus('offline');
            return;
          }
          timer = setTimer(connect, backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        });
    };
  };

  options.onStatus('connecting');
  connect();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
    source?.close();
  };
}
