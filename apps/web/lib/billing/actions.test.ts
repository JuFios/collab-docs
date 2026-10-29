import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';

const { apiServer, redirect } = vi.hoisted(() => ({
  apiServer: vi.fn(),
  // like Next's, it ends the action by throwing
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock('@/lib/api/server', () => ({ apiServer }));
vi.mock('next/navigation', () => ({ redirect }));

/** What a form posts. */
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

import { cancelSubscriptionAction, startCheckoutAction } from './actions';
import { settleCheckoutAction } from './mock-checkout-actions';

const WS = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const SESSION = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const EVENT = `evt_${'a'.repeat(32)}`;

beforeEach(() => {
  vi.clearAllMocks();
  apiServer.mockReset();
  vi.unstubAllEnvs();
});

describe('startCheckoutAction', () => {
  it('goes to the payment page the api returned', async () => {
    apiServer.mockResolvedValue({ sessionId: SESSION, checkoutUrl: `/mock-checkout/${SESSION}` });
    await expect(startCheckoutAction({}, form({ workspaceId: WS, plan: 'PRO' }))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(apiServer).toHaveBeenCalledWith(
      `/workspaces/${WS}/billing/checkout`,
      expect.objectContaining({ method: 'POST', body: { plan: 'PRO' } }),
    );
    expect(redirect).toHaveBeenCalledWith(`/mock-checkout/${SESSION}`);
  });

  it('refuses a plan that cannot be bought without calling the api', async () => {
    expect(await startCheckoutAction({}, form({ workspaceId: WS, plan: 'FREE' }))).toEqual({
      formError: 'Invalid request.',
    });
    expect(apiServer).not.toHaveBeenCalled();
  });

  it('reports a checkout for the current plan as the api words it', async () => {
    apiServer.mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'The workspace is already on the PRO plan'),
    );
    const state = await startCheckoutAction({}, form({ workspaceId: WS, plan: 'PRO' }));
    expect(state.formError).toBe('The workspace is already on the PRO plan');
    expect(state.ok).toBeUndefined();
  });
});

describe('cancelSubscriptionAction', () => {
  it('asks the api and waits for the Free plan', async () => {
    apiServer.mockResolvedValue(undefined);
    await expect(cancelSubscriptionAction({}, form({ workspaceId: WS }))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(apiServer).toHaveBeenCalledWith(`/workspaces/${WS}/billing/cancel`, { method: 'POST' });
    expect(redirect).toHaveBeenCalledWith(`/workspaces/${WS}/billing?awaiting=FREE`);
  });
});

describe('settleCheckoutAction', () => {
  const pending = {
    id: SESSION,
    workspaceId: WS,
    plan: 'TEAM',
    amountCents: 4900,
    status: 'PENDING',
  };

  function answers(session: unknown) {
    apiServer.mockImplementation(async (path: string) => {
      if (path.endsWith('/complete')) return { eventId: EVENT };
      if (path.endsWith('/fail')) return { eventId: EVENT };
      if (path.endsWith('/redeliver')) return { eventId: EVENT };
      return session;
    });
  }
  const posted = () =>
    apiServer.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path);

  it('pays and returns to billing to wait for the plan the session was for', async () => {
    answers(pending);
    await expect(
      settleCheckoutAction({}, form({ sessionId: SESSION, outcome: 'pay' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(posted()).toEqual([`/mock-provider/checkout-sessions/${SESSION}/complete`]);
    expect(redirect).toHaveBeenCalledWith(`/workspaces/${WS}/billing?awaiting=TEAM`);
  });

  it('declines the payment and says so on the billing page', async () => {
    answers(pending);
    await expect(
      settleCheckoutAction({}, form({ sessionId: SESSION, outcome: 'fail' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(posted()).toEqual([`/mock-provider/checkout-sessions/${SESSION}/fail`]);
    expect(redirect).toHaveBeenCalledWith(`/workspaces/${WS}/billing?payment=declined`);
  });

  it('pays and delivers the same event a second time', async () => {
    answers(pending);
    await expect(
      settleCheckoutAction({}, form({ sessionId: SESSION, outcome: 'pay_and_redeliver' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(posted()).toEqual([
      `/mock-provider/checkout-sessions/${SESSION}/complete`,
      `/mock-provider/events/${EVENT}/redeliver`,
    ]);
  });

  it('does not offer the re-send in staging', async () => {
    vi.stubEnv('APP_ENV', 'staging');
    answers(pending);
    const state = await settleCheckoutAction(
      {},
      form({ sessionId: SESSION, outcome: 'pay_and_redeliver' }),
    );
    expect(state.formError).toBe('This option is not available here.');
    expect(apiServer).not.toHaveBeenCalled();
  });

  it('leaves a session that is already settled alone', async () => {
    answers({ ...pending, status: 'COMPLETED' });
    const state = await settleCheckoutAction({}, form({ sessionId: SESSION, outcome: 'pay' }));
    expect(state.formError).toBe('This payment has already been settled.');
    expect(posted()).toEqual([]);
  });

  it('rejects an unknown outcome', async () => {
    expect(await settleCheckoutAction({}, form({ sessionId: SESSION, outcome: 'refund' }))).toEqual(
      {
        formError: 'Invalid request.',
      },
    );
  });
});
