// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmEmailBanner } from './confirm-email-banner';

afterEach(cleanup);

describe('ConfirmEmailBanner', () => {
  it('says what is needed and what is at stake when the address stays unconfirmed', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConfirmEmailBanner email="ada@example.com" />
      </QueryClientProvider>,
    );
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Confirm your email address');
    expect(notice).toHaveTextContent('ada@example.com');
    expect(notice).toHaveTextContent('nobody can share a document with you');
    expect(notice).toHaveTextContent(
      'unconfirmed 48 hours after sign-up can lose this address to a new registration',
    );
    expect(screen.getByRole('button', { name: 'Send the link again' })).toBeEnabled();
  });
});
