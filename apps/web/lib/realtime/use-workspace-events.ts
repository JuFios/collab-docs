'use client';

import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api/client';
import { type StreamStatus, openEventStream } from './event-stream';
import type { WorkspaceEvent } from './events';

export interface WorkspaceEventsHandlers {
  onEvent: (event: WorkspaceEvent) => void;
  /** The stream came back after an interruption; whatever was missed has to be refetched. */
  onResync: () => void;
}

/**
 * The tab's single SSE connection (`GET /api/events/stream?workspaceId=`). Mount it once per workspace; other
 * components receive events through the provider rather than opening their own stream.
 */
export function useWorkspaceEvents(
  workspaceId: string,
  handlers: WorkspaceEventsHandlers,
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    setStatus('connecting');
    return openEventStream({
      url: `/api/events/stream?workspaceId=${encodeURIComponent(workspaceId)}`,
      onEvent: (event) => latest.current.onEvent(event),
      onResync: () => latest.current.onResync(),
      onStatus: setStatus,
      refreshSession: () => apiClient.refresh(),
    });
  }, [workspaceId]);

  return status;
}
