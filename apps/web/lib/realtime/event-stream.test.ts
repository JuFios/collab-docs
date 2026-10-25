import { describe, expect, it, vi } from 'vitest';
import { type EventSourceLike, openEventStream } from './event-stream';

const WS = '00000000-0000-4000-8000-000000000001';

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: string) {
    this.listeners.get(type)?.({ data } as MessageEvent<string>);
  }
}

function setup(refreshSession = () => Promise.resolve()) {
  const sources: FakeSource[] = [];
  const timers: { callback: () => void; ms: number }[] = [];
  const onEvent = vi.fn();
  const onStatus = vi.fn();
  const onResync = vi.fn();
  const stop = openEventStream({
    url: '/api/events/stream?workspaceId=x',
    onEvent,
    onStatus,
    onResync,
    refreshSession,
    createSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    setTimer: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return { sources, timers, onEvent, onStatus, onResync, stop };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('openEventStream', () => {
  it('reports the status and parses known events only', () => {
    const { sources, onEvent, onStatus } = setup();
    const source = sources[0] as FakeSource;
    expect(onStatus).toHaveBeenLastCalledWith('connecting');
    source.onopen?.(new Event('open'));
    expect(onStatus).toHaveBeenLastCalledWith('open');

    source.emit(
      'tree.changed',
      JSON.stringify({ type: 'tree.changed', workspaceId: WS, version: 4 }),
    );
    source.emit('tree.changed', '{not json');
    source.emit('tree.changed', JSON.stringify({ type: 'tree.changed', version: 'x' }));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'tree.changed', workspaceId: WS, version: 4 });
  });

  it('lets the browser retry a dropped connection and resyncs once it is open again', () => {
    const { sources, timers, onStatus, onResync } = setup();
    const source = sources[0] as FakeSource;
    source.onopen?.(new Event('open'));
    source.readyState = 0;
    source.onerror?.(new Event('error'));
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    expect(timers).toHaveLength(0);
    expect(onResync).not.toHaveBeenCalled();
    source.onopen?.(new Event('open'));
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('renews the session and reconnects with growing backoff when the browser gave up', async () => {
    const refreshSession = vi.fn(() => Promise.resolve());
    const { sources, timers, onResync } = setup(refreshSession);
    (sources[0] as FakeSource).readyState = 2;
    (sources[0] as FakeSource).onerror?.(new Event('error'));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(timers.map((timer) => timer.ms)).toEqual([1_000]);

    timers[0]?.callback();
    expect(sources).toHaveLength(2);
    (sources[1] as FakeSource).readyState = 2;
    (sources[1] as FakeSource).onerror?.(new Event('error'));
    await flush();
    expect(timers.map((timer) => timer.ms)).toEqual([1_000, 2_000]);

    timers[1]?.callback();
    (sources[2] as FakeSource).onopen?.(new Event('open'));
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('goes offline when the session cannot be renewed', async () => {
    const { sources, timers, onStatus } = setup(() => Promise.reject(new Error('401')));
    (sources[0] as FakeSource).readyState = 2;
    (sources[0] as FakeSource).onerror?.(new Event('error'));
    await flush();
    expect(onStatus).toHaveBeenLastCalledWith('offline');
    expect(timers).toHaveLength(0);
  });

  it('stops listening once closed', () => {
    const { sources, stop, onEvent } = setup();
    const source = sources[0] as FakeSource;
    stop();
    expect(source.closed).toBe(true);
    source.emit(
      'tree.changed',
      JSON.stringify({ type: 'tree.changed', workspaceId: WS, version: 1 }),
    );
    expect(onEvent).not.toHaveBeenCalled();
  });
});
