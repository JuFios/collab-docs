// @vitest-environment jsdom
import type { NotificationResponse } from '@collab-docs/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceEventsHandlers } from '@/lib/realtime/use-workspace-events';

const request = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: { request: (...args: unknown[]) => request(...args) },
}));

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const toast = vi.fn();
vi.mock('sonner', () => ({ toast: (...args: unknown[]) => toast(...args) }));

// the SSE connection: the test plays the server by calling the handlers the provider registered
let stream: WorkspaceEventsHandlers | undefined;
vi.mock('@/lib/realtime/use-workspace-events', () => ({
  useWorkspaceEvents: (_workspaceId: string, handlers: WorkspaceEventsHandlers) => {
    stream = handlers;
    return 'open';
  },
}));

import { WorkspaceProvider } from '@/components/workspaces/workspace-provider';
import { NotificationBell } from './notification-bell';

const WS = '33333333-3333-4333-8333-333333333333';
const DOC = '44444444-4444-4444-8444-444444444444';
const THREAD = '55555555-5555-4555-8555-555555555555';

function notification(
  id: string,
  read = false,
  patch: Partial<NotificationResponse['payload']> = {},
) {
  return {
    id,
    type: 'MENTION',
    read,
    createdAt: '2030-01-01T10:00:00.000Z',
    payload: {
      workspaceId: WS,
      documentId: DOC,
      documentTitle: 'Launch plan',
      threadId: THREAD,
      commentId: '66666666-6666-4666-8666-666666666666',
      actor: { id: '77777777-7777-4777-8777-777777777777', name: 'Bob Stone' },
      excerpt: 'Can you check this?',
      ...patch,
    },
  } satisfies NotificationResponse;
}

let unread = 0;
let items: NotificationResponse[] = [];

beforeEach(() => {
  stream = undefined;
  request.mockImplementation((path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/notifications/unread-count') return Promise.resolve({ count: unread });
    if (path === '/notifications/read') {
      const body = init?.body as { ids?: string[]; all?: true };
      items = items.map((item) =>
        body.all || body.ids?.includes(item.id) ? { ...item, read: true } : item,
      );
      unread = items.filter((item) => !item.read).length;
      return Promise.resolve({ updated: 1 });
    }
    if (path.startsWith('/notifications?')) return Promise.resolve({ items, nextCursor: null });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

afterEach(() => {
  cleanup();
  request.mockReset();
  toast.mockReset();
  push.mockReset();
});

function mount(initialCount?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NotificationBell initialCount={initialCount} />
      <WorkspaceProvider workspaceId={WS} role="OWNER" initialTree={[]}>
        <p>workspace</p>
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

describe('NotificationBell', () => {
  it('shows the unread count it was given, and says it to screen readers', () => {
    unread = 3;
    mount(3);
    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expect(screen.getByTestId('unread-badge')).toHaveTextContent('3');
  });

  it('has no badge when everything is read', () => {
    unread = 0;
    mount(0);
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByTestId('unread-badge')).toBeNull();
  });

  it('caps a large count', () => {
    unread = 250;
    mount(250);
    expect(screen.getByTestId('unread-badge')).toHaveTextContent('99+');
  });

  it('counts a pushed notification without a reload, and announces it', async () => {
    unread = 0;
    items = [];
    mount(0);
    expect(stream).toBeDefined();
    const fresh = notification('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    items = [fresh];
    unread = 1;
    act(() => stream!.onEvent({ type: 'notification.created', notificationId: fresh.id }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Bob Stone mentioned you in “Launch plan”',
        expect.objectContaining({ description: 'Can you check this?' }),
      ),
    );
  });

  it('refreshes after the stream came back from an interruption', async () => {
    unread = 0;
    mount(0);
    unread = 2;
    act(() => stream!.onResync());
    await waitFor(() => expect(screen.getByTestId('unread-badge')).toHaveTextContent('2'));
  });

  it('ignores events that are not notifications', async () => {
    unread = 0;
    mount(0);
    const calls = request.mock.calls.length;
    act(() => stream!.onEvent({ type: 'tree.changed', workspaceId: WS, version: 4 }));
    expect(request.mock.calls.length).toBe(calls);
    expect(toast).not.toHaveBeenCalled();
  });

  it('lists notifications with a link to the thread, and marks one read when it is used', async () => {
    const first = notification('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const second = notification('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true, {
      documentTitle: 'Old doc',
    });
    items = [first, second];
    unread = 1;
    const user = userEvent.setup();
    mount(1);
    await user.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    const link = await screen.findByRole('menuitem', { name: /Launch plan/ });
    expect(link).toHaveAttribute('href', `/workspaces/${WS}/documents/${DOC}?thread=${THREAD}`);
    expect(link).toHaveTextContent('Unread');
    expect(screen.getByRole('menuitem', { name: /Old doc/ })).not.toHaveTextContent('Unread');
    await user.click(link);
    expect(request).toHaveBeenCalledWith(
      '/notifications/read',
      expect.objectContaining({ body: { ids: [first.id] } }),
    );
    await waitFor(() => expect(screen.queryByTestId('unread-badge')).toBeNull());
  });

  it('marks everything read in one go', async () => {
    items = [
      notification('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      notification('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ];
    unread = 2;
    const user = userEvent.setup();
    mount(2);
    await user.click(screen.getByRole('button', { name: /Notifications/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mark all as read' }));
    expect(request).toHaveBeenCalledWith(
      '/notifications/read',
      expect.objectContaining({ body: { all: true } }),
    );
    await waitFor(() => expect(screen.queryByTestId('unread-badge')).toBeNull());
  });

  it('says when there is nothing, and offers the full page', async () => {
    items = [];
    unread = 0;
    const user = userEvent.setup();
    mount(0);
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText(/all caught up/)).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'See all notifications' })).toHaveAttribute(
      'href',
      '/notifications',
    );
  });

  it('shows the text of a notification as text', async () => {
    items = [
      notification('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false, {
        excerpt: '<img src=x onerror=alert(1)>',
        documentTitle: '<script>alert(2)</script>',
      }),
    ];
    unread = 1;
    const user = userEvent.setup();
    mount(1);
    await user.click(screen.getByRole('button', { name: /Notifications/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(menu.querySelector('img, script')).toBeNull();
  });

  it('shows the loading state as a disabled menu item, with nothing a menu may not contain', async () => {
    request.mockImplementation((path: string) =>
      path === '/notifications/unread-count'
        ? Promise.resolve({ count: 0 })
        : new Promise(() => undefined),
    );
    const user = userEvent.setup();
    mount(0);
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Loading notifications/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(menu).queryByRole('status')).toBeNull();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    request.mockImplementation((path: string) =>
      path === '/notifications/unread-count'
        ? Promise.resolve({ count: 0 })
        : Promise.reject(new Error('down')),
    );
    const user = userEvent.setup();
    mount(0);
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    const menu = await screen.findByRole('menu');
    expect(await within(menu).findByText('Could not load notifications.')).toBeInTheDocument();
    // a menu item, not a button: a menu may only contain items, labels and separators
    expect(within(menu).getByRole('menuitem', { name: 'Try again' })).toBeInTheDocument();
    // focus moves to the retry, which the error describes, so a screen reader announces both
    const retry = within(menu).getByRole('menuitem', { name: 'Try again' });
    await waitFor(() => expect(retry).toHaveFocus());
    expect(retry).toHaveAccessibleDescription('Could not load notifications.');
  });
});
