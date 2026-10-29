'use client';

import {
  type Access,
  type CollabRejectReason,
  type CollabTicket,
  COLLAB_MESSAGE,
  accessAtLeast,
  base64ToBytes,
  collabRoomEventSchema,
  collabTicketSchema,
  stateVectorCovers,
} from '@collab-docs/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readVarString } from 'lib0/decoding';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { apiClient } from '@/lib/api/client';
import {
  type CollabError,
  MAX_RECOVERY_ROUNDS,
  backoffDelay,
  collabError,
  decideOnClose,
  decideOnTicketError,
} from './errors';

/**
 * `connecting`: the first connection is being made. `connected`: the socket is open. `disconnected`: the socket
 * was open once and is gone (the provider keeps trying). `closed`: the session ended; see `error`.
 */
export type CollabStatus = 'connecting' | 'connected' | 'disconnected' | 'closed';

interface DowngradeNotice {
  /** Local edits the server had not stored and that were dropped with the old `Y.Doc`. */
  discardedChanges: boolean;
}

/** Tickets live 60 s; one this young still opens a socket after the session is replaced. */
const TICKET_REUSE_MS = 30_000;

interface IssuedTicket extends CollabTicket {
  documentId: string;
  issuedAt: number;
}

interface RejectionNotice {
  reason: CollabRejectReason;
}

interface CollabConnectionOptions {
  onDowngrade?: (notice: DowngradeNotice) => void;
  /** The server refused a local change; the session starts over from the server's state without it. */
  onRejected?: (notice: RejectionNotice) => void;
  /** Where a ticket comes from; the default is the signed-in user's `collab-ticket`. Guests pass their link's. */
  fetchTicket?: (signal: AbortSignal) => Promise<CollabTicket>;
}

interface CollabConnection {
  /** Null until the first ticket arrived; both are replaced together when the session is recreated. */
  ydoc: Y.Doc | null;
  provider: WebsocketProvider | null;
  status: CollabStatus;
  /** The server state has been merged into `ydoc` (the first sync of this connection). */
  synced: boolean;
  /** Local changes the server has not reported as stored. */
  hasUnsyncedChanges: boolean;
  /** Null until the server's first `access` event. */
  accessLevel: Access | null;
  error: CollabError | null;
  /** Starts over after the session gave up (`error.kind === 'unavailable'`). */
  retry: () => void;
}

interface Snapshot {
  ydoc: Y.Doc | null;
  provider: WebsocketProvider | null;
  status: CollabStatus;
  synced: boolean;
  hasUnsyncedChanges: boolean;
  accessLevel: Access | null;
  error: CollabError | null;
}

const INITIAL: Snapshot = {
  ydoc: null,
  provider: null,
  status: 'connecting',
  synced: false,
  hasUnsyncedChanges: false,
  accessLevel: null,
  error: null,
};

/** State vector of a document without any change: nothing is persisted yet. */
const EMPTY_STATE_VECTOR = new Uint8Array([0]);

function fetchCollabTicket(documentId: string, signal: AbortSignal) {
  return apiClient.request(`/documents/${documentId}/collab-ticket`, {
    method: 'POST',
    schema: collabTicketSchema,
    signal,
  });
}

/**
 * The only place that opens a document's WebSocket. It owns the `Y.Doc` and the `WebsocketProvider`, fetches the
 * short-lived ticket before every (re)connect that needs one, turns close codes and room events into state and
 * recreates the document when the user's access drops to read-only or the server refuses a local change. Every
 * WebSocket failure goes through `decideOnClose` / `decideOnTicketError` in `./errors`.
 */
export function useCollabConnection(
  documentId: string,
  options: CollabConnectionOptions = {},
): CollabConnection {
  const [snapshot, setSnapshot] = useState<Snapshot>(INITIAL);
  // bumped to start a fresh session: after a downgrade, or when the user retries
  const [session, setSession] = useState(0);
  const onDowngrade = useRef(options.onDowngrade);
  onDowngrade.current = options.onDowngrade;
  const onRejected = useRef(options.onRejected);
  onRejected.current = options.onRejected;
  const fetchTicket = useRef(options.fetchTicket);
  fetchTicket.current = options.fetchTicket;
  // the session that replaces one whose change was refused connects with its ticket while it is fresh: a ticket may
  // open more sockets within its lifetime, and a full document refusing every keystroke must not cost a request each
  const carriedTicket = useRef<IssuedTicket | null>(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const abort = new AbortController();
    let provider: WebsocketProvider | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    let persisted: Uint8Array = EMPTY_STATE_VECTOR;
    let level: Access | null = null;
    let everConnected = false;
    let failedRounds = 0;
    let unsynced = false;
    // a local change the server has not confirmed as stored; a state vector alone cannot show a deletion
    let dirty = false;
    // this session's document is being replaced; further events of its socket change nothing
    let restarting = false;
    let lastTicket: IssuedTicket | null = null;

    const patch = (change: Partial<Snapshot>) => {
      if (alive) setSnapshot((current) => ({ ...current, ...change }));
    };

    const recomputeUnsynced = () => {
      unsynced = dirty || !stateVectorCovers(persisted, Y.encodeStateVector(ydoc));
      patch({ hasUnsyncedChanges: unsynced });
    };

    const giveUp = (error: CollabError) => {
      provider?.disconnect();
      patch({ status: 'closed', synced: false, error });
    };

    const scheduleConnect = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void connect(), delay);
    };

    const recoverWith = (action: 'new-ticket' | 'backoff') => {
      failedRounds += 1;
      if (failedRounds > MAX_RECOVERY_ROUNDS) {
        giveUp(collabError('unavailable'));
        return;
      }
      scheduleConnect(action === 'backoff' ? backoffDelay(failedRounds) : 0);
    };

    const restart = (keepTicket = false) => {
      restarting = true;
      carriedTicket.current = keepTicket ? lastTicket : null;
      setSession((value) => value + 1);
    };

    const handleRoomEvent = (raw: string) => {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return;
      }
      const parsed = collabRoomEventSchema.safeParse(json);
      if (!parsed.success) return;
      const event = parsed.data;
      if (restarting) return;
      if (event.type === 'persisted') {
        persisted = base64ToBytes(event.sv);
        // `saved` (absent from older servers) is the only acknowledgement that covers a deletion
        if (event.saved === true) dirty = false;
        recomputeUnsynced();
      } else if (event.type === 'access') {
        const previous = level;
        level = event.level;
        patch({ accessLevel: event.level });
        if (previous !== null && accessAtLeast(previous, 'EDIT') && event.readOnly) {
          // the server ignores this client's edits from now on; start over from the server's state
          onDowngrade.current?.({ discardedChanges: unsynced });
          restart();
        }
      } else if (event.type === 'rejected') {
        // the refused change and everything typed after it can never reach the room: drop them with this document
        onRejected.current?.({ reason: event.reason });
        restart(true);
      } else {
        giveUp(collabError('deleted'));
      }
    };

    const attach = (created: WebsocketProvider) => {
      created.on('status', ({ status }) => {
        if (status === 'connected') {
          everConnected = true;
          patch({ status: 'connected' });
        } else {
          patch({ status: everConnected ? 'disconnected' : 'connecting' });
        }
      });
      created.on('sync', (isSynced) => {
        patch({ synced: isSynced });
        if (isSynced) failedRounds = 0;
      });
      created.on('closed', ({ code }) => {
        const decision = decideOnClose(code);
        if (decision.action === 'stop') giveUp(decision.error);
        else if (decision.action !== 'reconnect') recoverWith(decision.action);
      });
      created.messageHandlers[COLLAB_MESSAGE.roomEvent] = (_encoder, decoder) =>
        handleRoomEvent(readVarString(decoder));
    };

    async function connect(): Promise<void> {
      try {
        const carried = carriedTicket.current;
        carriedTicket.current = null;
        if (
          carried &&
          carried.documentId === documentId &&
          Date.now() - carried.issuedAt < TICKET_REUSE_MS
        ) {
          lastTicket = carried;
        } else {
          const issued = await (
            fetchTicket.current ?? ((signal) => fetchCollabTicket(documentId, signal))
          )(abort.signal);
          lastTicket = { ...issued, documentId, issuedAt: Date.now() };
        }
        const { ticket, wsUrl } = lastTicket;
        if (!alive) return;
        if (provider) {
          // y-websocket builds the URL from `params` on every attempt
          provider.params.ticket = ticket;
          provider.connect();
          return;
        }
        provider = new WebsocketProvider(wsUrl, documentId, ydoc, {
          connect: false,
          params: { ticket },
          // updates must reach the server, which owns permissions and persistence, never only another tab
          disableBc: true,
        });
        attach(provider);
        patch({ ydoc, provider });
        provider.connect();
      } catch (error) {
        if (!alive || abort.signal.aborted) return;
        const decision = decideOnTicketError(error);
        if (decision.action === 'stop') giveUp(decision.error);
        else recoverWith('backoff');
      }
    }

    setSnapshot(INITIAL);
    ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      // updates applied from the provider come from the server and are not ours to acknowledge
      if (origin !== provider) dirty = true;
      recomputeUnsynced();
    });
    void connect();

    return () => {
      alive = false;
      abort.abort();
      clearTimeout(timer);
      provider?.destroy();
      // the editor bound to this document unmounts in the same commit; let it detach first
      setTimeout(() => ydoc.destroy(), 0);
    };
  }, [documentId, session]);

  const retry = useCallback(() => setSession((value) => value + 1), []);
  return { ...snapshot, retry };
}
