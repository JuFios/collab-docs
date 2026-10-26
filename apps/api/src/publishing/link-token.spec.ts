import { hashToken, newLinkToken } from './link-token';
import { statusOf } from './public-links.service';

describe('newLinkToken', () => {
  it('is 256 random bits in url-safe base64, stored only as a hash', () => {
    const { token, hash } = newLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
  });

  it('differs every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newLinkToken().token));
    expect(tokens.size).toBe(50);
  });
});

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
