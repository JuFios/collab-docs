// @vitest-environment jsdom
import type { TreeNode, WorkspaceRole } from '@collab-docs/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ apiClient: { request, refresh: vi.fn() } }));
vi.mock('@/lib/realtime/use-workspace-events', () => ({ useWorkspaceEvents: () => 'open' }));
const navigation = vi.hoisted(() => ({ docId: undefined as string | undefined, push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ docId: navigation.docId }),
  useRouter: () => ({ push: navigation.push, refresh: vi.fn() }),
  usePathname: () => '/w/ws',
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { WorkspaceProvider } from '@/components/workspaces/workspace-provider';
import { DocumentTree } from './document-tree';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (
  n: number,
  parent: number | null,
  position: string,
  patch: Partial<TreeNode> = {},
): TreeNode => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  title: `Doc ${n}`,
  icon: null,
  position,
  visibility: 'WORKSPACE',
  myAccess: 'EDIT',
  ...patch,
});
// 1 ─ 2 ; 3 ; 4
const nodes = [node(1, null, 'a0'), node(2, 1, 'a0'), node(3, null, 'a1'), node(4, null, 'a2')];

function renderTree(tree: TreeNode[] | undefined, role: WorkspaceRole = 'OWNER') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspaceId="ws" role={role} initialTree={tree}>
        <DocumentTree />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // the refetch after a mutation reads the (unchanged) server tree; mutations answer with a small document
  request.mockImplementation((path: string) =>
    Promise.resolve(path.endsWith('/tree') ? nodes : { id: id(3), parentId: null, position: 'a1' }),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  navigation.docId = undefined;
});

const item = (name: string) => screen.getByRole('treeitem', { name });

describe('DocumentTree', () => {
  it('renders the roots with collapsed branches and a live connection badge', () => {
    renderTree(nodes);
    expect(screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Doc 1',
      'Doc 3',
      'Doc 4',
    ]);
    expect(item('Doc 1')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Live');
  });

  it('opens the ancestors of the open document', () => {
    navigation.docId = id(2);
    renderTree(nodes);
    expect(item('Doc 2')).toHaveAttribute('aria-level', '2');
    expect(item('Doc 2')).toHaveAttribute('aria-current', 'page');
  });

  it('expands and collapses with the arrow keys and remembers it', async () => {
    const user = userEvent.setup();
    renderTree(nodes);
    item('Doc 1').focus();
    await user.keyboard('{ArrowRight}');
    expect(item('Doc 1')).toHaveAttribute('aria-expanded', 'true');
    expect(item('Doc 2')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('cd:tree-expanded:ws') ?? '[]')).toEqual([id(1)]);

    await user.keyboard('{ArrowDown}');
    expect(item('Doc 2')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(item('Doc 1')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(item('Doc 1')).toHaveAttribute('aria-expanded', 'false');
  });

  it('reorders with Alt+Arrow through the move endpoint', async () => {
    const user = userEvent.setup();
    // the api has not answered yet: what is on screen is the optimistic order
    request.mockImplementation((path: string) =>
      path.endsWith('/tree') ? Promise.resolve(nodes) : new Promise(() => undefined),
    );
    renderTree(nodes);
    item('Doc 3').focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        `/documents/${id(3)}/move`,
        expect.objectContaining({ method: 'POST', body: { parentId: null, beforeId: id(1) } }),
      ),
    );
    // optimistic: the new order is on screen without waiting for a refetch
    await waitFor(() =>
      expect(screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'))).toEqual([
        'Doc 3',
        'Doc 1',
        'Doc 4',
      ]),
    );
  });

  it('indents under the previous sibling and refuses moves that change nothing', async () => {
    const user = userEvent.setup();
    renderTree(nodes);
    item('Doc 3').focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        `/documents/${id(3)}/move`,
        expect.objectContaining({ body: { parentId: id(1) } }),
      ),
    );
    request.mockClear();
    item('Doc 1').focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(request).not.toHaveBeenCalled();
  });

  it('renames inline with F2 and Enter', async () => {
    const user = userEvent.setup();
    renderTree(nodes);
    item('Doc 4').focus();
    await user.keyboard('{F2}');
    const field = within(item('Doc 4')).getByRole('textbox', { name: 'Document title' });
    await user.clear(field);
    await user.type(field, 'Roadmap{Enter}');
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        `/documents/${id(4)}`,
        expect.objectContaining({ method: 'PATCH', body: { title: 'Roadmap' } }),
      ),
    );
  });

  it('asks for confirmation before moving to the trash', async () => {
    const user = userEvent.setup();
    renderTree(nodes);
    item('Doc 1').focus();
    await user.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Move “Doc 1” to trash?');
    expect(dialog).toHaveTextContent('1 subpage');
    expect(request).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Move to trash' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(`/documents/${id(1)}`, { method: 'DELETE' }),
    );
  });

  it('hides editing actions for documents the caller can only read', () => {
    renderTree(
      nodes.map((n) => ({ ...n, myAccess: 'VIEW' as const })),
      'VIEWER',
    );
    expect(screen.queryByRole('button', { name: /^Drag/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New document' })).not.toBeInTheDocument();
  });

  it('shows an empty state with a create button for editors only', () => {
    const { unmount } = renderTree([]);
    expect(screen.getByText('The workspace is empty.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create the first document' })).toBeInTheDocument();
    unmount();
    renderTree([], 'VIEWER');
    expect(screen.getByText(/Nothing has been shared/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create the first document' })).toBeNull();
  });

  it('shows a skeleton while the tree loads and a retry when it fails', async () => {
    request.mockRejectedValue(new Error('boom'));
    renderTree(undefined);
    expect(request).toHaveBeenCalledWith(
      '/workspaces/ws/documents/tree',
      expect.objectContaining({ schema: expect.anything() }),
    );
    expect(screen.getByLabelText('Loading documents')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
