// @vitest-environment jsdom
import type { TrashItem } from '@collab-docs/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const restoreMutate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/documents/queries', () => ({
  useRestoreDocument: () => ({ mutate: restoreMutate, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TrashList } from './trash-list';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const item = (overrides: Partial<TrashItem>): TrashItem => ({
  id: '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
  title: 'Old plan',
  icon: null,
  deletedAt: new Date().toISOString(),
  documentCount: 1,
  canRestore: true,
  ...overrides,
});

describe('TrashList', () => {
  it('restores a document and refreshes the list', async () => {
    restoreMutate.mockImplementation((_input, options) => options.onSuccess({ title: 'Old plan' }));
    render(<TrashList workspaceId="ws" items={[item({})]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(restoreMutate).toHaveBeenCalledWith(
      { id: '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b' },
      expect.anything(),
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it('says in text why a document cannot be restored, which a disabled button cannot do', () => {
    render(<TrashList workspaceId="ws" items={[item({ canRestore: false })]} />);
    const button = screen.getByRole('button', { name: 'Restore' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Only owners, admins or the author can restore it.');
    expect(screen.getByText('Only owners, admins or the author can restore it.')).toBeVisible();
  });

  it('mentions the subpages that come back with a document', () => {
    render(<TrashList workspaceId="ws" items={[item({ documentCount: 4 })]} />);
    expect(screen.getByText(/with 3 subpages/)).toBeInTheDocument();
  });
});
