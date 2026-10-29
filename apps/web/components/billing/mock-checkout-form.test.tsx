// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// the real action redirects on success; the mock just resolves
const actions = vi.hoisted(() => ({
  settleCheckoutAction: vi.fn<(state: unknown, form: FormData) => Promise<Record<string, unknown>>>(
    async () => ({}),
  ),
}));
vi.mock('@/lib/billing/mock-checkout-actions', () => actions);
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MockCheckoutForm } from './mock-checkout-form';

const SESSION = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

/** The form the action received: the session and the outcome of the button that submitted it. */
async function posted(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(actions.settleCheckoutAction).toHaveBeenCalledTimes(1));
  const data = actions.settleCheckoutAction.mock.calls[0]![1] as FormData;
  return Object.fromEntries(data.entries());
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MockCheckoutForm', () => {
  it('posts the payment as a plain form', async () => {
    render(<MockCheckoutForm sessionId={SESSION} amountLabel="$12.00" showRedeliver />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pay $12.00' }));
    expect(await posted()).toEqual({ sessionId: SESSION, outcome: 'pay' });
    // the action redirects; the browser does not navigate by itself
    expect(router.push).not.toHaveBeenCalled();
  });

  it('fails the payment', async () => {
    render(<MockCheckoutForm sessionId={SESSION} amountLabel="$12.00" showRedeliver />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fail payment' }));
    expect(await posted()).toEqual({ sessionId: SESSION, outcome: 'fail' });
  });

  it('offers the webhook re-send only where it is enabled', async () => {
    const { rerender } = render(
      <MockCheckoutForm sessionId={SESSION} amountLabel="$12.00" showRedeliver />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pay and re-send webhook' }));
    expect(await posted()).toEqual({ sessionId: SESSION, outcome: 'pay_and_redeliver' });
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
