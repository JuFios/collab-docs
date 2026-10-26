// @vitest-environment jsdom
import { COLLAB_CLOSE, COLLAB_MESSAGE, bytesToBase64 } from '@collab-docs/shared';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createDecoder } from 'lib0/decoding';
import { createEncoder, toUint8Array, writeVarString } from 'lib0/encoding';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ apiClient: { request } }));

type Listener = (...args: never[]) => void;

/** Just enough of `WebsocketProvider` for the hook: events, params and the connect/disconnect calls. */
class FakeProvider {
  static instances: FakeProvider[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly messageHandlers: Array<(...args: unknown[]) => void> = [];
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly destroy = vi.fn();
  params: Record<string, string>;

  constructor(
    readonly url: string,
    readonly room: string,
    readonly doc: Y.Doc,
    readonly options: { params: Record<string, string>; connect: boolean; disableBc: boolean },
  ) {
    this.params = { ...options.params };
    FakeProvider.instances.push(this);
  }

  on(name: string, listener: Listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  emit(name: string, payload: unknown) {
    for (const listener of this.listeners.get(name) ?? [])
      (listener as (p: unknown) => void)(payload);
  }

  roomEvent(event: unknown) {
    const encoder = createEncoder();
    writeVarString(encoder, JSON.stringify(event));
    this.messageHandlers[COLLAB_MESSAGE.roomEvent]?.(null, createDecoder(toUint8Array(encoder)));
  }
}

vi.mock('y-websocket', () => ({ WebsocketProvider: FakeProvider }));

const { useCollabConnection } = await import('./use-collab-connection');

const ticket = (n: number) => ({ ticket: `t${n}`, wsUrl: 'ws://collab.test/ws' });
const current = () => FakeProvider.instances.at(-1) as FakeProvider;

async function connected(options?: Parameters<typeof useCollabConnection>[1]) {
  const hook = renderHook(() => useCollabConnection('doc-1', options));
  await waitFor(() => expect(hook.result.current.provider).not.toBeNull());
  act(() => {
    current().emit('status', { status: 'connected' });
    current().emit('sync', true);
  });
  return hook;
}

beforeEach(() => {
  FakeProvider.instances = [];
  request.mockReset();
  let n = 0;
  request.mockImplementation(async () => ticket(++n));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCollabConnection', () => {
  it('fetches a ticket, opens the provider with it and reports the connection', async () => {
    const { result } = await connected();
    expect(request).toHaveBeenCalledWith(
      '/documents/doc-1/collab-ticket',
      expect.objectContaining({ method: 'POST' }),
    );
    const provider = current();
    expect(provider.url).toBe('ws://collab.test/ws');
    expect(provider.room).toBe('doc-1');
    expect(provider.options).toMatchObject({ params: { ticket: 't1' }, disableBc: true });
    expect(provider.connect).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ status: 'connected', synced: true, error: null });
  });

  it('keeps showing "connecting" until the first connection, then "disconnected" when it drops', async () => {
    const { result } = await connected();
    act(() => current().emit('status', { status: 'disconnected' }));
    act(() => current().emit('status', { status: 'connecting' }));
    expect(result.current.status).toBe('disconnected');
    act(() => current().emit('sync', false));
    expect(result.current.synced).toBe(false);
  });

  it('derives hasUnsyncedChanges from the persisted state vector', async () => {
    const { result } = await connected();
    const ydoc = result.current.ydoc as Y.Doc;
    act(() =>
      current().roomEvent({ type: 'persisted', sv: bytesToBase64(Y.encodeStateVector(ydoc)) }),
    );
    expect(result.current.hasUnsyncedChanges).toBe(false);

    act(() => ydoc.getText('t').insert(0, 'hello'));
    expect(result.current.hasUnsyncedChanges).toBe(true);

    act(() =>
      current().roomEvent({ type: 'persisted', sv: bytesToBase64(Y.encodeStateVector(ydoc)) }),
    );
    expect(result.current.hasUnsyncedChanges).toBe(false);
  });

  it('treats a local change as unsynced before the first persisted event', async () => {
    const { result } = await connected();
    act(() => (result.current.ydoc as Y.Doc).getText('t').insert(0, 'x'));
    expect(result.current.hasUnsyncedChanges).toBe(true);
  });

  it.each([
    [COLLAB_CLOSE.forbidden, 'forbidden'],
    [COLLAB_CLOSE.notFound, 'not-found'],
    [COLLAB_CLOSE.deleted, 'deleted'],
  ])('stops and disconnects on close code %i', async (code, kind) => {
    const { result } = await connected();
    act(() => current().emit('closed', { code, reason: '' }));
    expect(current().disconnect).toHaveBeenCalled();
    expect(result.current.status).toBe('closed');
    expect(result.current.error?.kind).toBe(kind);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('shows the deleted state on the room event too', async () => {
    const { result } = await connected();
    act(() => current().roomEvent({ type: 'deleted' }));
    expect(current().disconnect).toHaveBeenCalled();
    expect(result.current.error?.kind).toBe('deleted');
  });

  it('fetches a new ticket and reconnects on 4401', async () => {
    await connected();
    const provider = current();
    act(() => provider.emit('closed', { code: COLLAB_CLOSE.ticketInvalid, reason: '' }));
    await waitFor(() => expect(provider.params.ticket).toBe('t2'));
    expect(provider.connect).toHaveBeenCalledTimes(2);
    expect(FakeProvider.instances).toHaveLength(1);
  });

  it('gives up after repeated failures to get past 4401', async () => {
    const { result } = await connected();
    const provider = current();
    for (let round = 0; round < 6; round += 1) {
      await act(async () => {
        provider.emit('closed', { code: COLLAB_CLOSE.ticketInvalid, reason: '' });
        await Promise.resolve();
      });
    }
    await waitFor(() => expect(result.current.error?.kind).toBe('unavailable'));
    expect(result.current.status).toBe('closed');
  });

  it('waits before reconnecting after 4429', async () => {
    await connected();
    vi.useFakeTimers();
    const provider = current();
    act(() => provider.emit('closed', { code: COLLAB_CLOSE.rateLimited, reason: '' }));
    expect(provider.connect).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(provider.connect).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(provider.connect).toHaveBeenCalledTimes(2);
  });

  it('leaves transient closes to the provider', async () => {
    await connected();
    act(() => current().emit('closed', { code: 1006, reason: '' }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not open a socket when the ticket is refused', async () => {
    request.mockReset();
    request.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'no'));
    const { result } = renderHook(() => useCollabConnection('doc-1'));
    await waitFor(() => expect(result.current.error?.kind).toBe('forbidden'));
    expect(FakeProvider.instances).toHaveLength(0);
  });

  it('retries the ticket after a server error', async () => {
    request.mockReset();
    request.mockRejectedValueOnce(new ApiError(503, 'NETWORK_ERROR', 'offline'));
    request.mockResolvedValue(ticket(2));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useCollabConnection('doc-1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.provider).not.toBeNull();
  });

  it('records the live access level', async () => {
    const { result } = await connected();
    act(() => current().roomEvent({ type: 'access', level: 'EDIT', readOnly: false }));
    expect(result.current.accessLevel).toBe('EDIT');
  });

  it('starts over from the server state when access drops to read-only', async () => {
    const onDowngrade = vi.fn();
    const { result } = await connected({ onDowngrade });
    const first = current();
    const firstDoc = result.current.ydoc;
    act(() => first.roomEvent({ type: 'access', level: 'EDIT', readOnly: false }));
    act(() => (result.current.ydoc as Y.Doc).getText('t').insert(0, 'unsaved'));
    act(() => first.roomEvent({ type: 'access', level: 'VIEW', readOnly: true }));

    expect(onDowngrade).toHaveBeenCalledWith({ discardedChanges: true });
    await waitFor(() => expect(FakeProvider.instances).toHaveLength(2));
    expect(first.destroy).toHaveBeenCalled();
    await waitFor(() => expect(result.current.provider).toBe(current()));
    expect(result.current.ydoc).not.toBe(firstDoc);
    expect(current().params.ticket).toBe('t2');
  });

  it('does not recreate the document for a viewer that was always read-only', async () => {
    const onDowngrade = vi.fn();
    await connected({ onDowngrade });
    act(() => current().roomEvent({ type: 'access', level: 'VIEW', readOnly: true }));
    expect(onDowngrade).not.toHaveBeenCalled();
    expect(FakeProvider.instances).toHaveLength(1);
  });

  it('ignores malformed room events', async () => {
    const { result } = await connected();
    act(() => {
      current().messageHandlers[COLLAB_MESSAGE.roomEvent]?.(
        null,
        createDecoder(
          toUint8Array(
            (() => {
              const encoder = createEncoder();
              writeVarString(encoder, '{not json');
              return encoder;
            })(),
          ),
        ),
      );
      current().roomEvent({ type: 'nonsense' });
    });
    expect(result.current.error).toBeNull();
  });

  it('closes the provider on unmount and when the document changes', async () => {
    const { unmount } = await connected();
    const provider = current();
    unmount();
    expect(provider.destroy).toHaveBeenCalled();
  });

  it('can be restarted after it gave up', async () => {
    request.mockReset();
    request.mockRejectedValueOnce(new Error('boom'));
    request.mockResolvedValue(ticket(2));
    const { result } = renderHook(() => useCollabConnection('doc-1'));
    await waitFor(() => expect(result.current.error?.kind).toBe('unavailable'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.provider).not.toBeNull());
    expect(result.current.error).toBeNull();
  });
});
