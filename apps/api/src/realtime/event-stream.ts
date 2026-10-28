import type { MessageEvent } from '@nestjs/common';
import {
  type Observable,
  catchError,
  exhaustMap,
  filter,
  from,
  interval,
  map,
  merge,
  of,
  takeUntil,
} from 'rxjs';
import type { RealtimeEnvelope } from '@collab-docs/shared';

const HEARTBEAT_MS = 25_000;
/** How long the browser waits before it reconnects a dropped stream. */
const RECONNECT_MS = 3_000;

interface EventStreamSource {
  envelopes: Observable<RealtimeEnvelope>;
  /** Whether the caller still belongs to the workspace; asked on every heartbeat. */
  isMember: () => Promise<boolean>;
  heartbeatMs?: number;
}

/**
 * The messages of one `/events/stream` connection: the reconnect hint, the envelopes, and a comment line on
 * every heartbeat that keeps idle proxies from closing the connection. The stream completes when the
 * caller loses membership (a removed member must not keep receiving the workspace's events); Nest then
 * closes the response, and also unsubscribes from the source when the client disconnects.
 */
export function eventStream({
  envelopes,
  isMember,
  heartbeatMs = HEARTBEAT_MS,
}: EventStreamSource): Observable<MessageEvent> {
  const membershipLost = interval(heartbeatMs).pipe(
    // a failed lookup says nothing about membership, so the stream stays open until the next check
    exhaustMap(() => from(isMember()).pipe(catchError(() => of(true)))),
    filter((member) => !member),
  );
  return merge(
    of<MessageEvent>({ retry: RECONNECT_MS }),
    envelopes.pipe(map(({ event }): MessageEvent => ({ type: event.type, data: event }))),
    interval(heartbeatMs).pipe(map((): MessageEvent => ({ comment: 'ping' }))),
  ).pipe(takeUntil(membershipLost));
}
