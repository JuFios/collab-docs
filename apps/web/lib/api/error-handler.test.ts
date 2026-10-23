import { describe, expect, it, vi } from 'vitest';
import { createErrorHandlers } from './error-handler';
import { ApiError } from './errors';

function setup() {
  const toastError = vi.fn();
  const onPlanLimit = vi.fn();
  return { toastError, onPlanLimit, ...createErrorHandlers({ toastError, onPlanLimit }) };
}

describe('query errors', () => {
  it.each([401, 403, 404])('leaves %i to the page UI', (status) => {
    const { onQueryError, toastError } = setup();
    onQueryError(new ApiError(status, 'FORBIDDEN', 'x'));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts server errors with the correlation id', () => {
    const { onQueryError, toastError } = setup();
    onQueryError(new ApiError(500, 'INTERNAL_ERROR', 'boom', 'c-1'));
    expect(toastError).toHaveBeenCalledWith(
      'Something went wrong on our side. Please try again.',
      'Reference: c-1',
    );
  });
});

describe('mutation errors', () => {
  it('turns PLAN_LIMIT_EXCEEDED into an event instead of a toast', () => {
    const { onMutationError, toastError, onPlanLimit } = setup();
    onMutationError(
      new ApiError(403, 'PLAN_LIMIT_EXCEEDED', 'Document limit reached', 'c-2', { limit: 20 }),
    );
    expect(onPlanLimit).toHaveBeenCalledWith({
      message: 'Document limit reached',
      correlationId: 'c-2',
      details: { limit: 20 },
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('explains 403 and 429', () => {
    const { onMutationError, toastError } = setup();
    onMutationError(new ApiError(403, 'FORBIDDEN', 'no'));
    onMutationError(new ApiError(429, 'RATE_LIMITED', 'slow down'));
    expect(toastError).toHaveBeenNthCalledWith(
      1,
      "You don't have permission to do that.",
      undefined,
    );
    expect(toastError.mock.calls[1]?.[0]).toMatch(/Too many requests/);
  });

  it('stays silent on 401 (the client already redirected) and toasts unknown errors generically', () => {
    const { onMutationError, toastError } = setup();
    onMutationError(new ApiError(401, 'UNAUTHENTICATED', 'x'));
    expect(toastError).not.toHaveBeenCalled();
    onMutationError(new Error('weird'));
    expect(toastError).toHaveBeenCalledWith('Something went wrong. Please try again.');
  });
});
