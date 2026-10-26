import { statusOf } from './link-status';

describe('statusOf', () => {
  const now = new Date('2030-01-01T00:00:00Z');
  const later = new Date('2030-01-02T00:00:00Z');
  const earlier = new Date('2029-12-31T00:00:00Z');

  it.each([
    ['a link without expiry', { revokedAt: null, expiresAt: null }, 'active'],
    ['a link that expires later', { revokedAt: null, expiresAt: later }, 'active'],
    ['a link that expired', { revokedAt: null, expiresAt: earlier }, 'expired'],
    ['a link that expires right now', { revokedAt: null, expiresAt: now }, 'expired'],
    ['a revoked link', { revokedAt: earlier, expiresAt: null }, 'revoked'],
    ['a revoked link that also expired', { revokedAt: earlier, expiresAt: earlier }, 'revoked'],
  ])('%s is %s', (_label, link, status) => {
    expect(statusOf(link, now)).toBe(status);
  });
});
