import { hashToken, newLinkToken } from './link-token';

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
