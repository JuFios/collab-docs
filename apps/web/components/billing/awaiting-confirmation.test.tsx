// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AwaitingConfirmation, MAX_POLLS, POLL_INTERVAL_MS } from './awaiting-confirmation';

const PATH = '/w/abc/billing';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('AwaitingConfirmation', () => {
  it('asks the server for a fresh page while the plan has not changed', async () => {
    render(<AwaitingConfirmation expectedPlan="PRO" currentPlan="FREE" billingPath={PATH} />);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for the payment confirmation');
    expect(router.refresh).not.toHaveBeenCalled();
    await advance(POLL_INTERVAL_MS * 3);
    expect(router.refresh).toHaveBeenCalledTimes(3);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('confirms and clears the query string once the plan is the expected one', () => {
    const { rerender } = render(
      <AwaitingConfirmation expectedPlan="PRO" currentPlan="FREE" billingPath={PATH} />,
    );
    rerender(<AwaitingConfirmation expectedPlan="PRO" currentPlan="PRO" billingPath={PATH} />);
    expect(toast.success).toHaveBeenCalledWith('The workspace is now on the Pro plan.');
    expect(router.replace).toHaveBeenCalledWith(PATH);
  });

  it('stops after a bounded number of polls and offers another check', async () => {
    render(<AwaitingConfirmation expectedPlan="TEAM" currentPlan="FREE" billingPath={PATH} />);
    await advance(POLL_INTERVAL_MS * (MAX_POLLS + 2));
    expect(router.refresh).toHaveBeenCalledTimes(MAX_POLLS);
    expect(screen.getByText('Still waiting for the confirmation')).toBeInTheDocument();

    router.refresh.mockClear();
    await act(async () => screen.getByRole('button', { name: 'Check again' }).click());
    await advance(POLL_INTERVAL_MS);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
