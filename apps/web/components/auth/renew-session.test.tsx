// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const client = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ apiClient: client }));

import { RenewSession } from './renew-session';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RenewSession', () => {
  it('renders the page again once the session has been renewed', async () => {
    client.refresh.mockResolvedValue({});
    render(<RenewSession />);
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });

  it('leaves the page alone when there is no session to renew', async () => {
    client.refresh.mockRejectedValue(new Error('401'));
    render(<RenewSession />);
    await waitFor(() => expect(client.refresh).toHaveBeenCalledTimes(1));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('does not re-render a page the visitor has already left', async () => {
    let settle: (value: unknown) => void = () => undefined;
    client.refresh.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const { unmount } = render(<RenewSession />);
    unmount();
    settle({});
    await Promise.resolve();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
