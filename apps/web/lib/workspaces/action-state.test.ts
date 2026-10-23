import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { failureState, planLimitMessage } from './action-state';

describe('planLimitMessage', () => {
  it('explains a member limit, counting pending invitations, and offers an upgrade on Free', () => {
    const message = planLimitMessage({ kind: 'members', limit: 3, current: 3, plan: 'FREE' });
    expect(message).toContain('The Free plan allows 3 members');
    expect(message).toContain('pending invitations count too');
    expect(message).toContain('all of them are in use');
    expect(message).toContain('Revoke a pending invitation');
    expect(message).toContain('upgrade the plan');
  });

  it('does not offer an upgrade on the top plan', () => {
    const message = planLimitMessage({ kind: 'documents', limit: 100, current: 100, plan: 'TEAM' });
    expect(message).not.toContain('upgrade');
  });
});

describe('failureState', () => {
  it('maps validation errors to field errors and keeps the typed values', () => {
    const error = new ApiError(400, 'VALIDATION_FAILED', 'bad', 'c-1', [
      { field: 'email', messages: ['must be an email'] },
    ]);
    expect(failureState(error, { email: 'x' })).toEqual({
      values: { email: 'x' },
      fieldErrors: { email: ['must be an email'] },
      formError: 'Please fix the highlighted fields.',
    });
  });

  it('turns PLAN_LIMIT_EXCEEDED into a message plus the details for the upgrade dialog', () => {
    const details = { kind: 'members', limit: 3, current: 3, plan: 'FREE' };
    const state = failureState(new ApiError(403, 'PLAN_LIMIT_EXCEEDED', 'raw', 'c-2', details));
    expect(state.formError).toContain('Free plan allows 3 members');
    expect(state.planLimit).toEqual({ message: state.formError, details });
  });

  it('falls back to the server message when the limit details are malformed', () => {
    const state = failureState(new ApiError(403, 'PLAN_LIMIT_EXCEEDED', 'Limit reached', 'c', {}));
    expect(state).toEqual({ formError: 'Limit reached' });
  });

  it('hides server error details and rethrows what is not an ApiError', () => {
    expect(failureState(new ApiError(500, 'INTERNAL_ERROR', 'stack trace'))).toEqual({
      formError: 'Something went wrong. Please try again.',
    });
    expect(() => failureState(new Error('programming error'))).toThrow('programming error');
  });
});
