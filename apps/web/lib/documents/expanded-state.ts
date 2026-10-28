'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const keyOf = (workspaceId: string) => `cd:tree-expanded:${workspaceId}`;

function readExpanded(workspaceId: string): string[] {
  try {
    const raw = window.localStorage.getItem(keyOf(workspaceId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeExpanded(workspaceId: string, ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(keyOf(workspaceId), JSON.stringify([...ids]));
  } catch {
    // private mode or blocked storage: the tree still works, it just forgets
  }
}

/**
 * Which nodes are open. The first render shows only `forced` (ancestors of the open document) so server and client
 * markup match; the remembered set is merged in right after mount. Whenever `forced` changes (navigation, a move)
 * those branches are opened, but never closed again behind the user's back.
 */
export function useExpandedState(workspaceId: string, forced: readonly string[]) {
  const [state, setState] = useState(() => ({ loaded: false, ids: new Set(forced) }));
  const forcedKey = forced.join(',');
  const forcedRef = useRef(forced);
  forcedRef.current = forced;

  useEffect(() => {
    setState({ loaded: true, ids: new Set([...readExpanded(workspaceId), ...forcedRef.current]) });
  }, [workspaceId]);

  useEffect(() => {
    if (forcedKey === '') return;
    setState((current) => {
      if (!current.loaded || forcedRef.current.every((id) => current.ids.has(id))) return current;
      const ids = new Set([...current.ids, ...forcedRef.current]);
      writeExpanded(workspaceId, ids);
      return { loaded: true, ids };
    });
  }, [forcedKey, workspaceId]);

  const update = useCallback(
    (change: (ids: Set<string>) => void) => {
      setState((current) => {
        const ids = new Set(current.ids);
        change(ids);
        if (current.loaded) writeExpanded(workspaceId, ids);
        return { loaded: current.loaded, ids };
      });
    },
    [workspaceId],
  );

  const toggle = useCallback(
    (id: string) =>
      update((ids) => {
        if (!ids.delete(id)) ids.add(id);
      }),
    [update],
  );
  const expand = useCallback((id: string) => update((ids) => ids.add(id)), [update]);
  const collapse = useCallback((id: string) => update((ids) => ids.delete(id)), [update]);

  return { expanded: state.ids as ReadonlySet<string>, toggle, expand, collapse };
}
