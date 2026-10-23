// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  getCurrentUser: vi.fn(),
  getMembers: vi.fn(),
  getInvites: vi.fn(),
  getUsage: vi.fn(),
}));
vi.mock('@/lib/workspaces/data', () => data);
vi.mock('@/lib/workspaces/actions', () => ({}));

import SettingsPage from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const params = Promise.resolve({ id: '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b' });
const workspace = (role: string) => ({
  id: 'w',
  name: 'Acme',
  slug: 'acme',
  role,
  plan: 'FREE',
  createdAt: '',
});

describe('settings page', () => {
  it.each(['EDITOR', 'VIEWER'])(
    'shows the forbidden state to a %s without loading admin data',
    async (role) => {
      data.requireWorkspace.mockResolvedValue(workspace(role));
      render(await SettingsPage({ params }));
      expect(screen.getByText('Access denied')).toBeInTheDocument();
      expect(data.getMembers).not.toHaveBeenCalled();
      expect(data.getInvites).not.toHaveBeenCalled();
    },
  );
});
