// @vitest-environment jsdom
import type { BillingOverviewData } from '@collab-docs/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ requireWorkspace: vi.fn() }));
vi.mock('@/lib/workspaces/data', () => data);
const billingData = vi.hoisted(() => ({ getBilling: vi.fn() }));
vi.mock('@/lib/billing/data', () => billingData);
vi.mock('@/lib/billing/actions', () => ({
  startCheckoutAction: vi.fn(),
  cancelSubscriptionAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import BillingPage from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const WS = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const workspace = (role: string) => ({
  id: WS,
  name: 'Acme',
  slug: 'acme',
  role,
  plan: 'FREE',
  createdAt: '',
});

const free: BillingOverviewData = {
  plan: 'FREE',
  status: 'ACTIVE',
  currentPeriodEnd: null,
  usage: [
    { kind: 'members', current: 2, limit: 3 },
    { kind: 'documents', current: 17, limit: 20 },
    { kind: 'storage', current: 10 * 1024 * 1024, limit: 100 * 1024 * 1024 },
  ],
  overLimit: [],
  invoices: [],
};
const pro: BillingOverviewData = {
  ...free,
  plan: 'PRO',
  currentPeriodEnd: '2026-11-26T10:00:00.000Z',
  usage: [
    { kind: 'members', current: 2, limit: 10 },
    { kind: 'documents', current: 17, limit: 500 },
    { kind: 'storage', current: 10 * 1024 * 1024, limit: 5 * 1024 * 1024 * 1024 },
  ],
  invoices: [
    {
      id: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
      plan: 'PRO',
      amountCents: 1200,
      createdAt: '2026-10-27T10:00:00.000Z',
    },
  ],
};

async function show(
  overview: BillingOverviewData,
  query: Record<string, string> = {},
  role = 'OWNER',
) {
  data.requireWorkspace.mockResolvedValue(workspace(role));
  billingData.getBilling.mockResolvedValue(overview);
  render(
    await BillingPage({
      params: Promise.resolve({ workspaceId: WS }),
      searchParams: Promise.resolve(query),
    }),
  );
}

describe('billing page', () => {
  it.each(['EDITOR', 'VIEWER'])('keeps billing from a %s without loading it', async (role) => {
    await show(free, {}, role);
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(billingData.getBilling).not.toHaveBeenCalled();
  });

  it('offers both paid plans on Free and nothing to cancel', async () => {
    await show(free);
    expect(screen.getByRole('heading', { name: 'Current plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade to Team' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel subscription' })).not.toBeInTheDocument();
    expect(screen.getByText('No invoices yet')).toBeInTheDocument();
  });

  it('shows the usage against the limits and warns from 80%', async () => {
    await show(free);
    const documents = screen.getByRole('progressbar', { name: 'Documents used' });
    expect(documents).toHaveAttribute('aria-valuenow', '17');
    expect(documents).toHaveAttribute('aria-valuemax', '20');
    expect(screen.getByText('Almost at the limit.')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Members used' })).toHaveAttribute(
      'aria-valuenow',
      '2',
    );
  });

  it('on Pro shows the period, the invoice, a cancel button and a way down to Team or Free', async () => {
    await show(pro);
    expect(screen.getByText(/Paid through Nov 26, 2026/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upgrade to Pro' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade to Team' })).toBeInTheDocument();
    const invoices = screen.getByRole('region', { name: 'Invoices' });
    expect(within(invoices).getByText('$12.00')).toBeInTheDocument();
  });

  it('names the figures that are over the limit after a downgrade', async () => {
    await show({
      ...free,
      usage: [
        { kind: 'members', current: 2, limit: 3 },
        { kind: 'documents', current: 31, limit: 20 },
        { kind: 'storage', current: 0, limit: 100 * 1024 * 1024 },
      ],
      overLimit: [{ kind: 'documents', current: 31, limit: 20 }],
    });
    expect(screen.getByText('This workspace is over the Free limits')).toBeInTheDocument();
    expect(screen.getByText(/documents: 31 of 20/)).toBeInTheDocument();
    expect(screen.getByText('Limit reached.')).toBeInTheDocument();
  });

  it('waits for the webhook when the user comes back from the payment page', async () => {
    await show(free, { awaiting: 'PRO' });
    expect(screen.getByText('Waiting for the payment confirmation')).toBeInTheDocument();
  });

  it('does not wait once the plan has arrived', async () => {
    await show(pro, { awaiting: 'PRO' });
    expect(screen.queryByText('Waiting for the payment confirmation')).not.toBeInTheDocument();
  });

  it('explains a declined payment', async () => {
    await show(free, { payment: 'declined' });
    expect(screen.getByRole('alert')).toHaveTextContent('The payment was declined');
  });

  it('says so after a cancellation', async () => {
    await show({ ...free, status: 'CANCELED' });
    expect(screen.getByText('The subscription was canceled')).toBeInTheDocument();
  });
});
