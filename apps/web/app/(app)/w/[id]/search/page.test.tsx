// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ requireWorkspace: vi.fn(), searchDocuments: vi.fn() }));
vi.mock('@/lib/workspaces/data', () => data);
// the real one needs the app router; here it is the plain GET form it renders without scripts
vi.mock('next/form', () => ({
  default: (props: React.ComponentProps<'form'>) => <form {...props} />,
}));

import SearchPage, { generateMetadata } from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ID = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const params = Promise.resolve({ id: ID });

describe('search page', () => {
  it('shows the form and an invitation, and asks nothing, without a query', async () => {
    render(await SearchPage({ params, searchParams: Promise.resolve({}) }));
    const form = screen.getByRole('search');
    expect(form).toHaveAttribute('action', `/w/${ID}/search`);
    expect(screen.getByLabelText('Search documents')).toHaveAttribute('name', 'q');
    expect(screen.getByText('Search this workspace')).toBeInTheDocument();
    expect(data.searchDocuments).not.toHaveBeenCalled();
  });

  it('puts the query back in the field', async () => {
    render(await SearchPage({ params, searchParams: Promise.resolve({ q: '  café  ' }) }));
    expect(screen.getByLabelText('Search documents')).toHaveValue('café');
  });

  it('checks the membership first (a guest gets the 404 of requireWorkspace)', async () => {
    data.requireWorkspace.mockRejectedValue(new Error('NEXT_NOT_FOUND'));
    await expect(SearchPage({ params, searchParams: Promise.resolve({ q: 'x' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
  });

  it('titles the tab with the query', async () => {
    await expect(
      generateMetadata({ searchParams: Promise.resolve({ q: 'plan' }) }),
    ).resolves.toEqual({
      title: 'plan · Search · Collab Docs',
    });
    await expect(generateMetadata({ searchParams: Promise.resolve({}) })).resolves.toEqual({
      title: 'Search · Collab Docs',
    });
  });
});
