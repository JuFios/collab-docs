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
