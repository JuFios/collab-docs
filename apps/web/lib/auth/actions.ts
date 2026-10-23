'use server';

import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  type ErrorCode,
  authSessionSchema,
  loginInputSchema,
  registerInputSchema,
  sanitizeNextPath,
} from '@collab-docs/shared';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ZodType } from 'zod';
import { ApiError, parseBody, toApiError } from '@/lib/api/errors';
import { apiServerRaw } from '@/lib/api/server';
import { type AuthFormState, fieldErrorsFromZod, rateLimitMessage, textField } from './form-state';
import { parseSetCookies } from './set-cookie';

async function forwardSetCookies(response: Response): Promise<void> {
  const store = await cookies();
  for (const { name, value, ...options } of parseSetCookies(response.headers)) {
    store.set(name, value, options);
  }
}

function describeFailure(
  error: ApiError,
  retryAfter: number | undefined,
  credentialsMessage: string,
): AuthFormState {
  const code: ErrorCode | ApiError['code'] = error.code;
  if (code === 'VALIDATION_FAILED')
    return { fieldErrors: error.fieldErrors, formError: 'Please fix the highlighted fields.' };
  if (code === 'RATE_LIMITED') return { formError: rateLimitMessage(retryAfter) };
  if (code === 'UNAUTHENTICATED') return { formError: credentialsMessage };
  if (code === 'CONFLICT')
    return { fieldErrors: { email: ['An account with this email already exists.'] } };
  if (error.status >= 500 || code === 'NETWORK_ERROR') {
    return { formError: 'We could not reach the server. Please try again.' };
  }
  return { formError: error.message };
}

async function authenticate<T extends { email: string }>(
  endpoint: '/auth/login' | '/auth/register',
  schema: ZodType<T>,
  formData: FormData,
  credentialsMessage: string,
): Promise<AuthFormState> {
  const raw = { name: textField(formData, 'name'), email: textField(formData, 'email') };
  const parsed = schema.safeParse({ ...raw, password: textField(formData, 'password') });
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFromZod(parsed.error), values: raw };
  }

  let response: Response;
  try {
    response = await apiServerRaw(endpoint, { method: 'POST', body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError)
      return { ...describeFailure(error, undefined, credentialsMessage), values: raw };
    throw error;
  }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after')) || undefined;
    return {
      ...describeFailure(await toApiError(response), retryAfter, credentialsMessage),
      values: raw,
    };
  }
  parseBody(authSessionSchema, await response.json());
  await forwardSetCookies(response);
  return {};
}

export async function loginAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await authenticate(
    '/auth/login',
    loginInputSchema,
    formData,
    'Invalid email or password.',
  );
  if (result.fieldErrors || result.formError) return result;
  redirect(sanitizeNextPath(textField(formData, 'next')));
}

export async function registerAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await authenticate(
    '/auth/register',
    registerInputSchema,
    formData,
    'Could not create the account.',
  );
  if (result.fieldErrors || result.formError) return result;
  redirect(sanitizeNextPath(textField(formData, 'next')));
}

export async function logoutAction(): Promise<void> {
  try {
    await forwardSetCookies(await apiServerRaw('/auth/logout', { method: 'POST' }));
  } catch {
    // the local cookies are cleared below regardless; an unreachable api must not trap the user in a session
  }
  const store = await cookies();
  store.set(ACCESS_COOKIE, '', { path: '/', maxAge: 0 });
  store.set(REFRESH_COOKIE, '', { path: REFRESH_COOKIE_PATH, maxAge: 0 });
  redirect('/login');
}
