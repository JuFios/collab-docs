import type { MessageEvent } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { RealtimeEnvelope } from '@collab-docs/shared';
import { eventStream } from './event-stream';

const HEARTBEAT_MS = 1_000;

const envelope: RealtimeEnvelope = {
  scope: 'workspace',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  event: {
    type: 'tree.changed',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    version: 7,
  },
};

describe('eventStream', () => {
  let envelopes: Subject<RealtimeEnvelope>;
  let isMember: jest.Mock<Promise<boolean>, []>;
  let messages: MessageEvent[];
  let completed: boolean;

  const open = () =>
    eventStream({ envelopes, isMember, heartbeatMs: HEARTBEAT_MS }).subscribe({
      next: (message) => messages.push(message),
      complete: () => (completed = true),
    });

  beforeEach(() => {
    jest.useFakeTimers();
    envelopes = new Subject<RealtimeEnvelope>();
    isMember = jest.fn().mockResolvedValue(true);
    messages = [];
    completed = false;
  });

  afterEach(() => jest.useRealTimers());

  it('starts with the reconnect hint and relays envelopes as typed events', () => {
    const subscription = open();
    expect(messages).toEqual([{ retry: 3000 }]);

    envelopes.next(envelope);
    expect(messages[1]).toEqual({ type: 'tree.changed', data: envelope.event });
    subscription.unsubscribe();
  });

  it('sends a comment on every heartbeat and keeps the stream while the caller is a member', async () => {
    const subscription = open();
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);

    expect(messages.filter((m) => m.comment === 'ping')).toHaveLength(2);
    expect(isMember).toHaveBeenCalledTimes(2);
    expect(completed).toBe(false);
    subscription.unsubscribe();
  });

  it('completes once the caller is no longer a member', async () => {
    open();
    isMember.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(completed).toBe(true);
    const received = messages.length;
    envelopes.next(envelope);
    expect(messages).toHaveLength(received);
  });

  it('treats a failed membership lookup as no information', async () => {
    const subscription = open();
    isMember.mockRejectedValueOnce(new Error('db down'));
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(completed).toBe(false);

    isMember.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(completed).toBe(true);
    subscription.unsubscribe();
  });

  it('stops listening to the source and the timers when the client unsubscribes', async () => {
    open().unsubscribe();
    expect(envelopes.observed).toBe(false);

    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(isMember).not.toHaveBeenCalled();
  });
});
