// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicLink } from '@collab-docs/shared';

const createMutate = vi.fn();
const updateMutate = vi.fn();
vi.mock('@/lib/sharing/queries', () => ({
  useCreatePublicLink: () => ({ mutate: createMutate, isPending: false }),
  useUpdatePublicLink: () => ({ mutate: updateMutate, isPending: false }),
  useRevokePublicLink: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { PublishSection } from './publish-section';
import { publishBlock } from './share-dialog';

afterEach(() => {
  cleanup();
  createMutate.mockReset();
  updateMutate.mockReset();
});

const live: PublicLink = {
  id: 'l1',
  mode: 'VIEW',
  slug: 'plan-3fa9c1',
  status: 'active',
  expiresAt: null,
  revokedAt: null,
  createdAt: '2030-01-01T00:00:00.000Z',
};

describe('publishBlock', () => {
  it('lets a connected, saved document through', () => {
    expect(publishBlock({ online: true, synced: true, hasUnsyncedChanges: false })).toBeNull();
  });

  it.each([
    ['offline', { online: false, synced: true, hasUnsyncedChanges: false }, /offline/i],
    ['still connecting', { online: true, synced: false, hasUnsyncedChanges: false }, /connecting/i],
    ['unsaved changes', { online: true, synced: true, hasUnsyncedChanges: true }, /saving/i],
  ])('blocks when %s, and says why', (_label, state, message) => {
    expect(publishBlock(state)).toMatch(message);
  });
});

describe('PublishSection', () => {
  it('cannot publish while changes are still being saved', () => {
    render(
      <PublishSection
        documentId="d1"
        link={undefined}
        block="Saving your latest changes…"
        origin="http://localhost:3000"
      />,
    );
    expect(screen.getByRole('button', { name: 'Publish to web' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Saving your latest changes');
    fireEvent.click(screen.getByRole('button', { name: 'Publish to web' }));
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('publishes a view link once everything is stored', () => {
    render(
      <PublishSection
        documentId="d1"
        link={undefined}
        block={null}
        origin="http://localhost:3000"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish to web' }));
    expect(createMutate).toHaveBeenCalledWith({ mode: 'VIEW', expiresAt: null }, expect.anything());
  });

  it('shows the address of a live page and offers to unpublish it', () => {
    render(
      <PublishSection
        documentId="d1"
        link={live}
        block="ignored while published"
        origin="http://localhost:3000"
      />,
    );
    expect(screen.getByLabelText('Public link')).toHaveValue(
      'http://localhost:3000/published/plan-3fa9c1',
    );
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeEnabled();
  });

  it('keeps the stored expiry when the field is left as it is', () => {
    const expiring = { ...live, expiresAt: '2031-05-01T10:30:00.000Z' };
    render(
      <PublishSection
        documentId="d1"
        link={expiring}
        block={null}
        origin="http://localhost:3000"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update expiry' }));
    expect(updateMutate).toHaveBeenCalledWith(
      { linkId: 'l1', expiresAt: '2031-05-01T10:30:00.000Z' },
      expect.anything(),
    );
  });

  it('sends the date that was typed, and an emptied field removes the expiry', () => {
    const expiring = { ...live, expiresAt: '2031-05-01T10:30:00.000Z' };
    render(
      <PublishSection
        documentId="d1"
        link={expiring}
        block={null}
        origin="http://localhost:3000"
      />,
    );
    const field = screen.getByLabelText('Expires');
    fireEvent.change(field, { target: { value: '2032-01-02T03:04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update expiry' }));
    expect(updateMutate).toHaveBeenLastCalledWith(
      { linkId: 'l1', expiresAt: new Date('2032-01-02T03:04').toISOString() },
      expect.anything(),
    );
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update expiry' }));
    expect(updateMutate).toHaveBeenLastCalledWith(
      { linkId: 'l1', expiresAt: null },
      expect.anything(),
    );
  });
});
