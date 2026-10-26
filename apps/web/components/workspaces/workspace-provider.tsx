'use client';

import type { TreeNode, WorkspaceRole } from '@collab-docs/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { DOCUMENTS_KEY, trashKey, treeKey } from '@/lib/documents/keys';
import type { StreamStatus } from '@/lib/realtime/event-stream';
import type { WorkspaceEvent } from '@/lib/realtime/events';
import { useNotificationEvents } from '@/lib/notifications/live';
import { NOTIFICATIONS_KEY } from '@/lib/notifications/queries';
import { useWorkspaceEvents } from '@/lib/realtime/use-workspace-events';

type Listener = (event: WorkspaceEvent) => void;

interface WorkspaceContextValue {
  workspaceId: string;
  role: WorkspaceRole;
  /** Tree loaded by the layout; `undefined` when that fetch failed and the client has to load it itself. */
  initialTree: TreeNode[] | undefined;
  connection: StreamStatus;
  /** Lets other features (notifications) listen to the shared stream instead of opening their own. */
  subscribe: (listener: Listener) => () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** `null` outside a workspace frame: a guest opening a shared document has no tree and no stream. */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useOptionalWorkspace();
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return value;
}

/** Client boundary for everything in a workspace that reacts to the realtime stream. */
export function WorkspaceProvider({
  workspaceId,
  role,
  initialTree,
  children,
}: {
  workspaceId: string;
  role: WorkspaceRole;
  initialTree: TreeNode[] | undefined;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const listeners = useRef(new Set<Listener>());

  const refetchTree = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: treeKey(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: trashKey(workspaceId) });
    // titles and deletions change documents too; only mounted observers refetch
    void queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY });
  }, [queryClient, workspaceId]);

  const onNotification = useNotificationEvents();

  const connection = useWorkspaceEvents(workspaceId, {
    onEvent: (event) => {
      if (event.type === 'tree.changed' && event.workspaceId === workspaceId) refetchTree();
      // the stream carries this user's notifications from every workspace, not only this one's
      onNotification(event);
      for (const listener of listeners.current) listener(event);
    },
    onResync: () => {
      refetchTree();
      // a notification may have arrived while the stream was down
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    const current = listeners.current;
    return () => current.clear();
  }, []);

  const value = useMemo(
    () => ({ workspaceId, role, initialTree, connection, subscribe }),
    [workspaceId, role, initialTree, connection, subscribe],
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
