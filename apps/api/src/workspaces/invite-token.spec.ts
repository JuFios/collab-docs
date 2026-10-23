import { INVITE_TOKEN_PATTERN, hashToken, newInviteToken } from './invite-token';

describe('invite token', () => {
  it('is 43 url-safe characters and stored only as a hash', () => {
    const { token, hash } = newInviteToken();
    expect(token).toMatch(INVITE_TOKEN_PATTERN);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
  });

  it('is unique per call', () => {
    expect(newInviteToken().token).not.toBe(newInviteToken().token);
  });

  it('rejects malformed tokens before any lookup', () => {
    for (const bad of ['', 'short', 'a'.repeat(44), `${'a'.repeat(42)}!`, "' OR 1=1 --"]) {
      expect(bad).not.toMatch(INVITE_TOKEN_PATTERN);
    }
  });
});
