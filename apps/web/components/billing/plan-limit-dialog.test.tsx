// @vitest-environment jsdom
import type { WorkspaceRole } from '@collab-docs/shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitPlanLimitExceeded } from '@/lib/api/plan-limit-events';

const workspace = vi.hoisted(() => ({
  current: null as null | { workspaceId: string; role: WorkspaceRole },
}));
vi.mock('@/components/workspaces/workspace-provider', () => ({
  useOptionalWorkspace: () => workspace.current,
}));

import { PlanLimitDialog } from './plan-limit-dialog';

const WS = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const documentsFull = { kind: 'documents', limit: 20, current: 20, plan: 'FREE' };

function raise(details: unknown, message = 'Plan limit reached') {
  act(() => emitPlanLimitExceeded({ message, details }));
}

afterEach(() => {
  cleanup();
  workspace.current = null;
});

describe('PlanLimitDialog', () => {
  it('stays closed until a limit is hit', () => {
    render(<PlanLimitDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each<WorkspaceRole>(['OWNER', 'ADMIN'])(
    'lets a %s upgrade, and says which limit was hit',
    (role) => {
      workspace.current = { workspaceId: WS, role };
      render(<PlanLimitDialog />);
      raise(documentsFull);
      expect(screen.getByRole('dialog', { name: 'Limit reached' })).toBeInTheDocument();
      expect(screen.getByText('Documents: 20 of 20 used on the Free plan.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Upgrade plan' })).toHaveAttribute(
        'href',
        `/w/${WS}/billing`,
      );
    },
  );

  it.each<WorkspaceRole>(['EDITOR', 'VIEWER'])('tells a %s to ask an admin', (role) => {
    workspace.current = { workspaceId: WS, role };
    render(<PlanLimitDialog />);
    raise({ kind: 'members', limit: 3, current: 3, plan: 'FREE' });
    expect(screen.getByText(/Ask your workspace admin to upgrade the plan/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Upgrade plan' })).not.toBeInTheDocument();
    expect(screen.getByText('Members: 3 of 3 used on the Free plan.')).toBeInTheDocument();
  });

  it('formats a storage limit in bytes units', () => {
    workspace.current = { workspaceId: WS, role: 'ADMIN' };
    render(<PlanLimitDialog />);
    raise({ kind: 'storage', limit: 100 * 1024 * 1024, current: 99 * 1024 * 1024, plan: 'FREE' });
    expect(screen.getByText('Storage: 99 MB of 100 MB used on the Free plan.')).toBeInTheDocument();
  });

  it('has nothing to upgrade on the largest plan', () => {
    workspace.current = { workspaceId: WS, role: 'OWNER' };
    render(<PlanLimitDialog />);
    raise({ kind: 'members', limit: 50, current: 50, plan: 'TEAM' });
    expect(screen.queryByRole('link', { name: 'Upgrade plan' })).not.toBeInTheDocument();
    expect(screen.getByText(/largest plan/)).toBeInTheDocument();
  });

  it('works outside a workspace frame, without an upgrade link', () => {
    render(<PlanLimitDialog />);
    raise(documentsFull);
    expect(screen.getByText(/Ask your workspace admin/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Upgrade plan' })).not.toBeInTheDocument();
  });

  it('falls back to the api message when the details cannot be read', () => {
    render(<PlanLimitDialog />);
    raise({ unexpected: true }, 'Document limit reached');
    expect(screen.getByText('Document limit reached')).toBeInTheDocument();
  });

  it('closes', async () => {
    workspace.current = { workspaceId: WS, role: 'EDITOR' };
    render(<PlanLimitDialog />);
    raise(documentsFull);
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
