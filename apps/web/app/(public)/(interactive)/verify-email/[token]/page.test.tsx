// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';

const apiServer = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/server', () => ({ apiServer }));

import VerifyEmailPage from './page';

const TOKEN = 'a'.repeat(43);
const open = () => VerifyEmailPage({ params: Promise.resolve({ token: TOKEN }) });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('verify email page', () => {
  it('confirms the address with the token from the link', async () => {
    apiServer.mockResolvedValue(undefined);
    render(await open());
    expect(screen.getByText('Email address confirmed')).toBeInTheDocument();
    expect(apiServer).toHaveBeenCalledWith('/auth/verify-email', {
      method: 'POST',
      body: { token: TOKEN },
    });
  });

  it('explains an expired or replaced link', async () => {
    apiServer.mockRejectedValue(new ApiError(400, 'BAD_REQUEST', 'invalid'));
    render(await open());
    expect(screen.getByText('Link not valid')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your workspaces' })).toHaveAttribute(
      'href',
      '/workspaces',
    );
  });

  it('lets any other failure reach the error page', async () => {
    apiServer.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    await expect(open()).rejects.toThrow();
  });
});
