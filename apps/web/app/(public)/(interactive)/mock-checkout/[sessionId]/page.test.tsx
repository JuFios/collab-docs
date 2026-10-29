// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';

const apiPublic = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/public', () => ({ apiPublic }));
vi.mock('@/lib/billing/mock-checkout-actions', () => ({ settleCheckoutAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import MockCheckoutPage from './page';

const SESSION = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const WS = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const session = (status: string) => ({
  id: SESSION,
  workspaceId: WS,
  plan: 'PRO',
  amountCents: 1200,
  status,
});
const open = (id = SESSION) => MockCheckoutPage({ params: Promise.resolve({ sessionId: id }) });

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('mock checkout page', () => {
  it('shows the plan and the amount with the way to pay or decline', async () => {
    apiPublic.mockResolvedValue(session('PENDING'));
    render(await open());
    expect(screen.getByRole('heading', { name: 'Collab Docs Pro' })).toBeInTheDocument();
    expect(screen.getByText('$12.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay $12.00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fail payment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay and re-send webhook' })).toBeInTheDocument();
    // the state of a payment must come from the api every time
    expect(apiPublic).toHaveBeenCalledWith(
      `/mock-provider/checkout-sessions/${SESSION}`,
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('hides the webhook re-send in staging', async () => {
    vi.stubEnv('APP_ENV', 'staging');
    apiPublic.mockResolvedValue(session('PENDING'));
    render(await open());
    expect(
      screen.queryByRole('button', { name: 'Pay and re-send webhook' }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ['COMPLETED', 'This payment has been completed.'],
    ['FAILED', 'This payment was declined.'],
    ['CANCELED', 'This checkout was replaced by a newer one and can no longer be paid.'],
  ])('shows a %s session as settled, with a way back', async (status, text) => {
    apiPublic.mockResolvedValue(session(status));
    render(await open());
    expect(screen.getByRole('status')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: /Pay/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to billing' })).toHaveAttribute(
      'href',
      `/workspaces/${WS}/billing`,
    );
  });

  it('answers 404 for an unknown session and for an id that is not a uuid', async () => {
    apiPublic.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Not found'));
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
    apiPublic.mockClear();
    await expect(open('not-a-uuid')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(apiPublic).not.toHaveBeenCalled();
  });
});
