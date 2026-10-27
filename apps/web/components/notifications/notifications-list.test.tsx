// @vitest-environment jsdom
import type { NotificationPage, NotificationResponse } from '@collab-docs/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: { request: (...args: unknown[]) => request(...args) },
}));

import { NotificationsList } from './notifications-list';

const WS = '33333333-3333-4333-8333-333333333333';
const DOC = '44444444-4444-4444-8444-444444444444';
const THREAD = '55555555-5555-4555-8555-555555555555';

function item(n: number, read = false): NotificationResponse {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    type: 'MENTION',
    read,
    createdAt: '2030-01-01T10:00:00.000Z',
    payload: {
      workspaceId: WS,
      documentId: DOC,
      documentTitle: `Doc ${n}`,
      threadId: THREAD,
      commentId: '66666666-6666-4666-8666-666666666666',
      actor: { id: '77777777-7777-4777-8777-777777777777', name: 'Bob Stone' },
      excerpt: `Excerpt ${n}`,
    },
  };
}

let unread = 0;
let items: NotificationResponse[] = [];

beforeEach(() => {
  items = [];
  request.mockImplementation((path: string, init?: { body?: { all?: true } }) => {
    if (path === '/notifications/unread-count') return Promise.resolve({ count: unread });
    if (path === '/notifications/read') {
      if (init?.body?.all) {
        unread = 0;
        items = items.map((entry) => ({ ...entry, read: true }));
      }
      return Promise.resolve({ updated: 1 });
    }
    return Promise.resolve({ items, nextCursor: null });
  });
});
afterEach(() => {
  cleanup();
  request.mockReset();
});

function mount(initialPage: NotificationPage) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  render(
    <QueryClientProvider client={client}>
      <NotificationsList initialPage={initialPage} />
    </QueryClientProvider>,
  );
}

describe('NotificationsList', () => {
  it('renders the page the server sent, without asking for it again', () => {
    mount({ items: [item(1), item(2, true)], nextCursor: null });
    const list = screen.getByRole('list', { name: 'Notifications' });
    expect(list).toHaveTextContent('Doc 1');
    expect(list).toHaveTextContent('Doc 2');
    expect(request).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/notifications\?/),
      expect.anything(),
    );
    expect(screen.getByRole('link', { name: /Doc 1/ })).toHaveAttribute(
      'href',
      `/w/${WS}/d/${DOC}?thread=${THREAD}`,
    );
  });

  it('loads further pages with the cursor', async () => {
    const user = userEvent.setup();
    request.mockImplementation((path: string) =>
      path.startsWith('/notifications?')
        ? Promise.resolve({ items: [item(3)], nextCursor: null })
        : Promise.resolve({ count: 2 }),
    );
    mount({ items: [item(1), item(2)], nextCursor: 'cursor-1' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText(/Doc 3/)).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining('cursor=cursor-1'),
      expect.anything(),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  });

  it('marks all as read while there is something unread', async () => {
    unread = 1;
    items = [item(1)];
    const user = userEvent.setup();
    mount({ items: [item(1)], nextCursor: null });
    await user.click(await screen.findByRole('button', { name: 'Mark all as read' }));
    expect(request).toHaveBeenCalledWith(
      '/notifications/read',
      expect.objectContaining({ body: { all: true } }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull(),
    );
    expect(screen.getByRole('link', { name: /Doc 1/ })).not.toHaveTextContent('Unread');
  });

  it('explains an empty inbox', () => {
    unread = 0;
    mount({ items: [], nextCursor: null });
    expect(screen.getByText('No notifications yet')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
