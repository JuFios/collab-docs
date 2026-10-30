import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AccessTokenError, signAccessToken, verifyAccessToken } from './auth';

const secret = 'unit-test-secret-unit-test-secret';
const userId = '0190b1c2-0000-7000-8000-000000000001';

describe('access tokens', () => {
  it('round-trips subject, jti and expiry', async () => {
    const { token, jti, expiresIn } = await signAccessToken(secret, userId);
    const claims = await verifyAccessToken(token, secret);
    expect(claims.sub).toBe(userId);
    expect(claims.jti).toBe(jti);
    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(expiresIn);
  });

  it('reports an expired token distinctly from an invalid one', async () => {
    const { token } = await signAccessToken(secret, userId, {
      now: new Date(Date.now() - 3600_000),
    });
    await expect(verifyAccessToken(token, secret)).rejects.toMatchObject({ reason: 'expired' });
    await expect(verifyAccessToken('not-a-jwt', secret)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('rejects a wrong secret, wrong audience and missing claims', async () => {
    const { token } = await signAccessToken(secret, userId);
    await expect(
      verifyAccessToken(token, 'another-secret-another-secret!!'),
    ).rejects.toBeInstanceOf(AccessTokenError);
    const key = new TextEncoder().encode(secret);
    const wrongAudience = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setJti('x')
      .setAudience('other')
      .setExpirationTime('5m')
      .sign(key);
    await expect(verifyAccessToken(wrongAudience, secret)).rejects.toMatchObject({
      reason: 'invalid',
    });
    const noJti = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience('api')
      .setExpirationTime('5m')
      .sign(key);
    await expect(verifyAccessToken(noJti, secret)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects tokens signed with a different algorithm', async () => {
    const key = new TextEncoder().encode(secret);
    const hs512 = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(userId)
      .setJti('x')
      .setAudience('api')
      .setExpirationTime('5m')
      .sign(key);
    await expect(verifyAccessToken(hs512, secret)).rejects.toMatchObject({ reason: 'invalid' });
  });
});

describe('form input schemas', () => {
  it('normalises and validates login input', async () => {
    const { loginInputSchema } = await import('./auth');
    expect(loginInputSchema.parse({ email: '  Ada@Example.COM ', password: 'x' }).email).toBe(
      'ada@example.com',
    );
    expect(loginInputSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
    expect(loginInputSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });

  it('enforces the registration password bounds of the api', async () => {
    const { registerInputSchema, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } =
      await import('./auth');
    const base = { name: 'Ada', email: 'a@b.co' };
    expect(
      registerInputSchema.safeParse({ ...base, password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1) })
        .success,
    ).toBe(false);
    expect(
      registerInputSchema.safeParse({ ...base, password: 'x'.repeat(PASSWORD_MIN_LENGTH) }).success,
    ).toBe(true);
    expect(
      registerInputSchema.safeParse({ ...base, password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(
      registerInputSchema.safeParse({ ...base, name: '   ', password: 'x'.repeat(12) }).success,
    ).toBe(false);
  });

  it('refuses to register the placeholder address of a released account', async () => {
    const { registerInputSchema, releasedEmail } = await import('./auth');
    const input = (email: string) => ({ name: 'Ada', email, password: 'x'.repeat(12) });
    expect(registerInputSchema.safeParse(input(releasedEmail(userId))).success).toBe(false);
    expect(registerInputSchema.safeParse(input('  Anyone@Released.Invalid ')).success).toBe(false);
    expect(registerInputSchema.safeParse(input('ada@released.invalid.example')).success).toBe(true);
  });

  it('refuses to invite the placeholder address, but accepts any other', async () => {
    const { inviteInputSchema } = await import('./workspaces');
    const { releasedEmail } = await import('./auth');
    const invite = (email: string) => ({ email, role: 'EDITOR' });
    expect(inviteInputSchema.safeParse(invite(releasedEmail(userId))).success).toBe(false);
    expect(inviteInputSchema.safeParse(invite('ada@example.com')).success).toBe(true);
  });
});

describe('released addresses', () => {
  it('sit on a domain that never resolves, whatever the case', async () => {
    const { isReleasedEmail, releasedEmail } = await import('./auth');
    expect(releasedEmail('abc')).toBe('abc@released.invalid');
    expect(isReleasedEmail('abc@released.invalid')).toBe(true);
    expect(isReleasedEmail('ABC@Released.Invalid')).toBe(true);
  });

  it('are not mistaken for other addresses', async () => {
    const { isReleasedEmail } = await import('./auth');
    expect(isReleasedEmail('ada@example.com')).toBe(false);
    expect(isReleasedEmail('ada@released.invalid.example.com')).toBe(false);
    expect(isReleasedEmail('ada@notreleased.invalid')).toBe(false);
  });
});
