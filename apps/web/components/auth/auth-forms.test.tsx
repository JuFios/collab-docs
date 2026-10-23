// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { loginAction, registerAction } = vi.hoisted(() => ({
  loginAction: vi.fn(async () => ({})),
  registerAction: vi.fn(async () => ({
    fieldErrors: { email: ['An account with this email already exists.'] },
  })),
}));
vi.mock('@/lib/auth/actions', () => ({ loginAction, registerAction }));

import { LoginForm } from './login-form';
import { RegisterForm } from './register-form';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoginForm', () => {
  it('shows client-side validation errors without calling the action', async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(loginAction).not.toHaveBeenCalled();
  });

  it('submits valid credentials to the action with the next path', async () => {
    const user = userEvent.setup();
    render(<LoginForm next="/w/abc" />);
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(loginAction).toHaveBeenCalledTimes(1));
    const formData = (loginAction.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(formData.get('email')).toBe('ada@example.com');
    expect(formData.get('next')).toBe('/w/abc');
  });
});

describe('RegisterForm', () => {
  it('requires a long enough password', async () => {
    const user = userEvent.setup();
    render(<RegisterForm />);
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 10 characters.')).toBeInTheDocument();
    expect(registerAction).not.toHaveBeenCalled();
  });

  it('renders field errors returned by the server action', async () => {
    const user = userEvent.setup();
    render(<RegisterForm />);
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'long-enough-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      await screen.findByText('An account with this email already exists.'),
    ).toBeInTheDocument();
  });
});
