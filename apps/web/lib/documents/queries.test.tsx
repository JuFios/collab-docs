// @vitest-environment jsdom
import type { TreeNode } from '@collab-docs/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ apiClient: { request } }));
vi.mock('@/components/workspaces/workspace-provider', () => ({
  useWorkspace: () => ({ workspaceId: 'ws', role: 'OWNER', initialTree: undefined }),
}));

import { treeKey } from './keys';
import { useDeleteDocument, useMoveDocument, useSaveDocumentTitle } from './queries';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, parent: number | null, position: string): TreeNode => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  title: `Doc ${n}`,
  icon: null,
  position,
  visibility: 'WORKSPACE',
  myAccess: 'EDIT',
});
const seed = [node(1, null, 'a0'), node(2, 1, 'a0'), node(3, null, 'a1')];

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(treeKey('ws'), seed);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

const cached = (queryClient: QueryClient) => queryClient.getQueryData<TreeNode[]>(treeKey('ws'));

afterEach(() => request.mockReset());

/** An api call that stays pending until the test settles it, so the optimistic state can be observed. */
function deferred() {
  let fail: (reason: unknown) => void = () => undefined;
  const promise = new Promise((_, reject) => {
    fail = reject;
  });
  return { promise, fail };
}

describe('tree mutations', () => {
  it('moves optimistically, before the api answers', async () => {
    let finish: (value: unknown) => void = () => undefined;
    request.mockImplementation((path: string) =>
      path.endsWith('/move')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(seed),
    );
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useMoveDocument('ws'), { wrapper });

    act(() => result.current.mutate({ id: id(3), plan: { parentId: id(1) } }));
    await waitFor(() =>
      expect(cached(queryClient)?.find((n) => n.id === id(3))?.parentId).toBe(id(1)),
    );
    expect(request).toHaveBeenCalledWith(
      `/documents/${id(3)}/move`,
      expect.objectContaining({ method: 'POST', body: { parentId: id(1) } }),
    );
    finish({ id: id(3), parentId: id(1), position: 'a1' });
  });

  it('puts the tree back when the api refuses the move', async () => {
    request.mockImplementation((path: string) =>
      path.endsWith('/move') ? Promise.reject(new Error('409')) : Promise.resolve(seed),
    );
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useMoveDocument('ws'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: id(3), plan: { parentId: id(1) } }).catch(() => null);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(cached(queryClient)).toEqual(seed);
  });

  it('removes a deleted document with its subtree and restores them on failure', async () => {
    const call = deferred();
    request.mockImplementation((_path: string, init?: { method?: string }) =>
      init?.method === 'DELETE' ? call.promise : Promise.resolve(seed),
    );
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useDeleteDocument('ws'), { wrapper });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync({ id: id(1) }).catch(() => null);
    });
    await waitFor(() => expect(cached(queryClient)?.map((n) => n.id)).toEqual([id(3)]));
    await act(async () => {
      call.fail(new Error('403'));
      await pending;
    });
    await waitFor(() => expect(cached(queryClient)).toEqual(seed));
  });

  it('renames optimistically and rolls back on error', async () => {
    const call = deferred();
    request.mockImplementation((_path: string, init?: { method?: string }) =>
      init?.method === 'PATCH' ? call.promise : Promise.resolve(seed),
    );
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useSaveDocumentTitle('ws'), { wrapper });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync({ id: id(3), title: 'New' }).catch(() => null);
    });
    await waitFor(() =>
      expect(cached(queryClient)?.find((n) => n.id === id(3))?.title).toBe('New'),
    );
    await act(async () => {
      call.fail(new Error('500'));
      await pending;
    });
    await waitFor(() =>
      expect(cached(queryClient)?.find((n) => n.id === id(3))?.title).toBe('Doc 3'),
    );
  });

  it('sends tree writes one at a time, in the order they were made', async () => {
    const answers: ((value: unknown) => void)[] = [];
    request.mockImplementation((path: string) =>
      path.endsWith('/move')
        ? new Promise((resolve) => {
            answers.push(resolve);
          })
        : Promise.resolve(seed),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useMoveDocument('ws'), { wrapper });

    act(() => {
      result.current.mutate({ id: id(3), plan: { parentId: id(1) } });
      result.current.mutate({ id: id(3), plan: { parentId: null, beforeId: id(1) } });
    });
    await waitFor(() => expect(answers).toHaveLength(1));
    const moves = () => request.mock.calls.filter(([path]) => String(path).endsWith('/move'));
    expect(moves()).toHaveLength(1);

    answers[0]?.({ id: id(3), parentId: id(1), position: 'a1' });
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(moves().map(([, init]) => init.body)).toEqual([
      { parentId: id(1) },
      { parentId: null, beforeId: id(1) },
    ]);
  });
});
