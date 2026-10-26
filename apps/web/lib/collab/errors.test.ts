import { COLLAB_CLOSE } from '@collab-docs/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { backoffDelay, decideOnClose, decideOnTicketError } from './errors';

describe('decideOnClose', () => {
  it.each([
    [COLLAB_CLOSE.forbidden, 'forbidden'],
    [COLLAB_CLOSE.notFound, 'not-found'],
    [COLLAB_CLOSE.deleted, 'deleted'],
  ])('stops for %i', (code, kind) => {
    const decision = decideOnClose(code);
    expect(decision.action).toBe('stop');
    expect(decision.action === 'stop' && decision.error.kind).toBe(kind);
  });

  it('asks for a new ticket on 4401', () => {
    expect(decideOnClose(COLLAB_CLOSE.ticketInvalid)).toEqual({ action: 'new-ticket' });
  });

  it('backs off on 4429', () => {
    expect(decideOnClose(COLLAB_CLOSE.rateLimited)).toEqual({ action: 'backoff' });
  });

  it.each([1000, 1006, 1009, 1011])('leaves %i to the provider', (code) => {
    expect(decideOnClose(code)).toEqual({ action: 'reconnect' });
  });
});

describe('decideOnTicketError', () => {
  it('stops without access', () => {
    expect(decideOnTicketError(new ApiError(403, 'FORBIDDEN', 'no'))).toMatchObject({
      action: 'stop',
      error: { kind: 'forbidden' },
    });
    expect(decideOnTicketError(new ApiError(404, 'NOT_FOUND', 'no'))).toMatchObject({
      action: 'stop',
      error: { kind: 'not-found' },
    });
  });

  it.each([
    new ApiError(429, 'RATE_LIMITED', 'slow down'),
    new ApiError(503, 'NETWORK_ERROR', 'offline'),
    new ApiError(500, 'INTERNAL_ERROR', 'oops'),
  ])('retries later after %s', (error) => {
    expect(decideOnTicketError(error)).toEqual({ action: 'backoff' });
  });

  it('gives up on anything else', () => {
    expect(decideOnTicketError(new Error('boom'))).toMatchObject({
      action: 'stop',
      error: { kind: 'unavailable' },
    });
  });
});

describe('backoffDelay', () => {
  it('doubles from one second up to a cap', () => {
    expect([1, 2, 3, 4].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(20)).toBe(30_000);
  });
});
