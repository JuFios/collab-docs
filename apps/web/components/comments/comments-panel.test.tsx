// @vitest-environment jsdom
import type { ThreadResponse } from '@collab-docs/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: { request: (...args: unknown[]) => request(...args) },
}));

import { CommentsPanel } from './comments-panel';

const ANN = '11111111-1111-4111-8111-111111111111';
const viewer = { id: ANN, name: 'Ann Lee' };
const BOB = '22222222-2222-4222-8222-222222222222';

function thread(id: string, blockId: string, patch: Partial<ThreadResponse> = {}): ThreadResponse {
  return {
    id,
    documentId: 'doc-1',
    blockId,
    orphaned: false,
    resolved: false,
    resolvedAt: null,
    createdAt: '2030-01-01T10:00:00.000Z',
    comments: [
      {
        id: `${id}-c1`,
        author: { id: BOB, name: 'Bob Stone' },
        body: `First comment of ${id}`,
        deleted: false,
        mentions: [],
        createdAt: '2030-01-01T10:00:00.000Z',
        editedAt: null,
      },
    ],
    ...patch,
  };
}

let threads: ThreadResponse[] = [];

beforeEach(() => {
  // jsdom has no layout, so no scrolling
  Element.prototype.scrollIntoView = vi.fn();
  request.mockImplementation((path: string, init?: { method?: string; body?: unknown }) => {
    if (path.startsWith('/documents/doc-1/threads') && !init?.method) {
      return Promise.resolve(threads);
    }
    if (path.startsWith('/documents/doc-1/mentionable')) return Promise.resolve([]);
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  request.mockReset();
});

function mount(props: Partial<Parameters<typeof CommentsPanel>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CommentsPanel
        documentId="doc-1"
        viewer={viewer}
        canComment
        editor={null}
        composeBlockId={null}
        onComposeEnd={() => undefined}
        activeThreadId={null}
        onSelectThread={() => undefined}
        onClose={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('CommentsPanel', () => {
  it('shows a loading state, then the threads grouped by block', async () => {
    threads = [thread('t1', 'b1'), thread('t2', 'b1'), thread('t3', 'b2')];
    mount();
    expect(screen.getByRole('status')).toHaveTextContent('Loading comments');
    const cards = await screen.findAllByTestId('comment-thread');
    expect(cards).toHaveLength(3);
    const groups = screen.getAllByRole('region');
    expect(groups).toHaveLength(2);
    expect(within(groups[0]!).getAllByTestId('comment-thread')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Comments (3 open)' })).toBeInTheDocument();
  });

  it('keeps resolved threads out of sight until asked', async () => {
    threads = [thread('open', 'b1'), thread('done', 'b2', { resolved: true })];
    const user = userEvent.setup();
    mount();
    expect(await screen.findAllByTestId('comment-thread')).toHaveLength(1);
    await user.click(screen.getByLabelText('Show resolved threads'));
    expect(screen.getAllByTestId('comment-thread')).toHaveLength(2);
    expect(screen.getByText(/Resolved thread/)).toBeInTheDocument();
  });

  it('shows a resolved thread that something pointed at', async () => {
    threads = [thread('done', 'b2', { resolved: true })];
    mount({ activeThreadId: 'done' });
    expect(await screen.findByTestId('comment-thread')).toHaveAttribute('data-thread-id', 'done');
  });

  it('puts threads of deleted blocks in a section of their own', async () => {
    threads = [thread('t1', 'b1'), thread('t2', 'gone', { orphaned: true })];
    mount();
    const section = await screen.findByRole('region', { name: 'Comments on deleted blocks' });
    expect(within(section).getAllByTestId('comment-thread')).toHaveLength(1);
    expect(within(section).getByText(/has been removed/)).toBeInTheDocument();
  });

  it('says so when there is nothing yet', async () => {
    threads = [];
    mount();
    expect(await screen.findByText(/No comments yet\. Use the comment button/)).toBeInTheDocument();
  });

  it('lets a reader read, but gives no way to write or resolve', async () => {
    threads = [thread('t1', 'b1')];
    mount({ canComment: false });
    expect(await screen.findByText('First comment of t1')).toBeInTheDocument();
    expect(screen.getByTestId('comments-readonly')).toHaveTextContent(/need comment access/);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Resolve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('shows markup in a comment as plain text', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script> <b>bold?</b>';
    threads = [
      thread('t1', 'b1', {
        comments: [{ ...thread('x', 'b1').comments[0]!, body: payload }],
      }),
    ];
    const { container } = mount();
    expect(await screen.findByTestId('comment-body')).toHaveTextContent(payload);
    expect(container.querySelector('img, script, b')).toBeNull();
  });

  it('names mentioned people and never shows a raw id', async () => {
    threads = [
      thread('t1', 'b1', {
        comments: [
          {
            ...thread('x', 'b1').comments[0]!,
            body: `Hi @[${ANN}] and @[${BOB}]`,
            mentions: [{ userId: ANN, name: 'Ann Lee' }],
          },
        ],
      }),
    ];
    mount();
    const body = await screen.findByTestId('comment-body');
    expect(body).toHaveTextContent('Hi @Ann Lee and @someone');
    expect(body).not.toHaveTextContent(BOB);
  });

  it('starts a thread on the chosen block and shows it at once', async () => {
    threads = [];
    const user = userEvent.setup();
    const onComposeEnd = vi.fn();
    let answer: () => void = () => undefined;
    request.mockImplementation((path: string, init?: { method?: string; body?: unknown }) => {
      if (init?.method === 'POST' && path === '/documents/doc-1/threads') {
        // the api answers only when the test lets it
        return new Promise((resolve) => {
          answer = () => {
            threads = [
              thread('real', 'b9', {
                comments: [{ ...thread('x', 'b9').comments[0]!, body: 'Looks off' }],
              }),
            ];
            resolve({ thread: threads[0], warnings: [] });
          };
        });
      }
      if (path.startsWith('/documents/doc-1/threads')) return Promise.resolve(threads);
      return Promise.resolve([]);
    });
    mount({ composeBlockId: 'b9', onComposeEnd });
    const field = await screen.findByRole('combobox', { name: 'New comment' });
    expect(field).toHaveFocus();
    await user.type(field, 'Looks off');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    // optimistic: the thread is there while the request is still open
    expect(await screen.findByText('Looks off')).toBeInTheDocument();
    expect(onComposeEnd).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      '/documents/doc-1/threads',
      expect.objectContaining({ method: 'POST', body: { blockId: 'b9', body: 'Looks off' } }),
    );
    answer();
    await waitFor(() => expect(onComposeEnd).toHaveBeenCalled());
    expect(await screen.findByText('Looks off')).toBeInTheDocument();
  });

  it('rolls an optimistic reply back when the api refuses it', async () => {
    threads = [thread('t1', 'b1')];
    const user = userEvent.setup();
    request.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && path === '/threads/t1/comments') {
        return Promise.reject(new Error('refused'));
      }
      if (path.startsWith('/documents/doc-1/threads')) return Promise.resolve(threads);
      return Promise.resolve([]);
    });
    mount();
    const field = await screen.findByRole('combobox', { name: /Reply/ });
    await user.type(field, 'This will fail');
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(field).toHaveValue('This will fail'));
    expect(screen.queryByText('This will fail', { selector: 'p' })).toBeNull();
  });

  it('resolves a thread', async () => {
    threads = [thread('t1', 'b1')];
    const user = userEvent.setup();
    mount();
    request.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        threads = [{ ...threads[0]!, resolved: true, resolvedAt: '2030-01-02T00:00:00.000Z' }];
        return Promise.resolve(threads[0]);
      }
      return Promise.resolve(threads);
    });
    await user.click(await screen.findByRole('button', { name: /Resolve/ }));
    expect(request).toHaveBeenCalledWith(
      '/threads/t1/resolve',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => expect(screen.queryByTestId('comment-thread')).toBeNull());
  });

  it('asks to select a block when its name is clicked, and closes on Escape', async () => {
    threads = [thread('t1', 'b1')];
    const user = userEvent.setup();
    const onSelectThread = vi.fn();
    const onClose = vi.fn();
    mount({ onSelectThread, onClose });
    await user.click(await screen.findByRole('button', { name: /Block/ }));
    expect(onSelectThread).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
