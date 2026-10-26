'use client';

import {
  type Access,
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

export interface DowngradeNotice {
  /** Local edits the server had not stored and that were dropped with the old `Y.Doc`. */
  discardedChanges: boolean;
}

export interface CollabConnectionOptions {
  onDowngrade?: (notice: DowngradeNotice) => void;
}

export interface CollabConnection {
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
 * recreates the document when the user's access drops to read-only. Every WebSocket failure goes through
 * `decideOnClose` / `decideOnTicketError` in `./errors`.
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

    const patch = (change: Partial<Snapshot>) => {
      if (alive) setSnapshot((current) => ({ ...current, ...change }));
    };

    const recomputeUnsynced = () => {
      unsynced = !stateVectorCovers(persisted, Y.encodeStateVector(ydoc));
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
      if (event.type === 'persisted') {
        persisted = base64ToBytes(event.sv);
        recomputeUnsynced();
      } else if (event.type === 'access') {
        const previous = level;
        level = event.level;
        patch({ accessLevel: event.level });
        if (previous !== null && accessAtLeast(previous, 'EDIT') && event.readOnly) {
          // the server ignores this client's edits from now on; start over from the server's state
          onDowngrade.current?.({ discardedChanges: unsynced });
          setSession((value) => value + 1);
        }
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
        const { ticket, wsUrl } = await fetchCollabTicket(documentId, abort.signal);
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
    ydoc.on('update', recomputeUnsynced);
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
