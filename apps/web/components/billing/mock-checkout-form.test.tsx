// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  settleCheckoutAction: vi.fn(async (...args: unknown[]): Promise<Record<string, unknown>> => ({
    ok: args.length > 0,
    redirectTo: '/w/abc/billing?awaiting=PRO',
  })),
}));
vi.mock('@/lib/billing/mock-checkout-actions', () => actions);
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MockCheckoutForm } from './mock-checkout-form';

const SESSION = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MockCheckoutForm', () => {
  it('pays and follows the action to the billing page', async () => {
    render(<MockCheckoutForm sessionId={SESSION} amountLabel="$12.00" showRedeliver />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pay $12.00' }));
    await waitFor(() =>
      expect(actions.settleCheckoutAction).toHaveBeenCalledWith({
        sessionId: SESSION,
        outcome: 'pay',
      }),
    );
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/w/abc/billing?awaiting=PRO'));
  });

  it('fails the payment', async () => {
    render(<MockCheckoutForm sessionId={SESSION} amountLabel="$12.00" showRedeliver />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fail payment' }));
    await waitFor(() =>
      expect(actions.settleCheckoutAction).toHaveBeenCalledWith({
        sessionId: SESSION,
        outcome: 'fail',
      }),
    );
  });

  it('offers the webhook re-send only where it is enabled', async () => {
    const { rerender } = render(
      <MockCheckoutForm sessionId={SESSION} amountLabel="$12.00" showRedeliver />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pay and re-send webhook' }));
    await waitFor(() =>
      expect(actions.settleCheckoutAction).toHaveBeenCalledWith({
        sessionId: SESSION,
        outcome: 'pay_and_redeliver',
      }),
    );
    rerender(<MockCheckoutForm sessionId={SESSION} amountLabel="$12.00" showRedeliver={false} />);
    expect(
      screen.queryByRole('button', { name: 'Pay and re-send webhook' }),
    ).not.toBeInTheDocument();
  });

  it('shows why a payment could not be made and stays on the page', async () => {
    actions.settleCheckoutAction.mockResolvedValueOnce({
      formError: 'This payment has already been settled.',
    });
    render(<MockCheckoutForm sessionId={SESSION} amountLabel="$12.00" showRedeliver={false} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pay $12.00' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already been settled');
    expect(router.push).not.toHaveBeenCalled();
  });
});
