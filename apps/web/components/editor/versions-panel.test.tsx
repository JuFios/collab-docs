// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: { request: (...args: unknown[]) => request(...args) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { VersionsPanel } from './versions-panel';

const AUTO = { id: 'v-auto', kind: 'AUTO', label: null, createdAt: '2030-01-01T10:00:00.000Z' };
const SAVED = {
  id: 'v-saved',
  kind: 'MANUAL',
  label: 'first draft',
  createdAt: '2030-01-02T10:00:00Z',
};
const CONTENT = {
  title: 'Handbook',
  content: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text of the draft' }] }],
  },
};

/** Which reads fail (once, or until cleared) is decided per test. */
const failing = new Set<string>();

beforeEach(() => {
  failing.clear();
  request.mockImplementation((path: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${path}`;
    if (failing.has(key)) return Promise.reject(new Error('outage'));
    if (key === 'GET /documents/doc-1/versions') return Promise.resolve([SAVED, AUTO]);
    if (key.startsWith('GET /documents/doc-1/versions/')) return Promise.resolve(CONTENT);
    if (key.endsWith('/restore')) return Promise.resolve({ restored: true });
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  request.mockReset();
});

function mount(canEdit: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VersionsPanel documentId="doc-1" canEdit={canEdit} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('VersionsPanel', () => {
  it('lists the snapshots and previews the one that is picked', async () => {
    const user = userEvent.setup();
    mount(true);
    await user.click(await screen.findByRole('button', { name: /first draft/ }));

    const preview = await screen.findByRole('region', { name: 'Version preview' });
    expect(await within(preview).findByText('Text of the draft')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore this version' })).toBeTruthy();
  });

  it('offers a reader neither saving nor restoring', async () => {
    const user = userEvent.setup();
    mount(false);
    await user.click(await screen.findByRole('button', { name: /first draft/ }));

    await screen.findByRole('region', { name: 'Version preview' });
    expect(screen.queryByRole('button', { name: 'Save version' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull();
  });

  it('restores only after the confirmation', async () => {
    const user = userEvent.setup();
    mount(true);
    await user.click(await screen.findByRole('button', { name: /first draft/ }));
    await user.click(await screen.findByRole('button', { name: 'Restore this version' }));
    expect(request).not.toHaveBeenCalledWith(
      '/documents/doc-1/versions/v-saved/restore',
      expect.anything(),
    );

    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore' }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/documents/doc-1/versions/v-saved/restore',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('says when the history cannot be read and reads it again on "Try again"', async () => {
    const user = userEvent.setup();
    failing.add('GET /documents/doc-1/versions');
    mount(true);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load the version history.',
    );

    failing.clear();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /first draft/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when a version cannot be previewed and reads it again on "Try again"', async () => {
    const user = userEvent.setup();
    failing.add('GET /documents/doc-1/versions/v-saved');
    mount(true);
    await user.click(await screen.findByRole('button', { name: /first draft/ }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load this version.',
    );

    failing.clear();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Text of the draft')).toBeTruthy();
  });
});
