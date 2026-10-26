import { JwtService } from '@nestjs/jwt';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_TTL_SECONDS,
  signAccessToken,
  verifyAccessToken,
} from '@collab-docs/shared';
import { AccessTokenService } from './access-token.service';

const SECRET = 'contract-test-secret-contract-test-secret';
const USER_ID = '0190b1c2-0000-7000-8000-000000000001';

const options = {
  secret: SECRET,
  signOptions: { algorithm: 'HS256' as const, audience: ACCESS_TOKEN_AUDIENCE },
  verifyOptions: { algorithms: ['HS256' as const], audience: ACCESS_TOKEN_AUDIENCE },
};

const decode = (token: string, part: 0 | 1): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[part] ?? '', 'base64url').toString('utf8'));

/**
 * The api issues access tokens with @nestjs/jwt and the web app's edge middleware verifies them with jose
 * (`verifyAccessToken` in @collab-docs/shared). These tests pin the format both ways, so changing either side
 * fails here rather than in production.
 */
describe('access token contract (@nestjs/jwt <-> jose)', () => {
  const jwt = new JwtService(options);
  const service = new AccessTokenService(jwt);

  it('verifies a token issued by the service with jose, claims intact', async () => {
    const { token, jti, expiresIn } = await service.sign(USER_ID);

    const claims = await verifyAccessToken(token, SECRET);
    expect(claims).toMatchObject({ sub: USER_ID, jti });
    expect(expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);

    expect(decode(token, 0)).toMatchObject({ alg: 'HS256' });
    const payload = decode(token, 1);
    expect(payload).toMatchObject({ sub: USER_ID, jti, aud: ACCESS_TOKEN_AUDIENCE });
    expect(typeof payload.iat).toBe('number');
    expect((payload.exp as number) - (payload.iat as number)).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(claims.exp).toBe(payload.exp);
  });

  it('verifies a token issued by jose with the service, claims intact', async () => {
    const { token, jti } = await signAccessToken(SECRET, USER_ID, { jti: 'jti-from-jose' });
    await expect(service.verify(token)).resolves.toMatchObject({ sub: USER_ID, jti });
    expect(decode(token, 1)).toMatchObject({ aud: ACCESS_TOKEN_AUDIENCE });
  });

  it('honours the issue time and a custom lifetime the same way on both sides', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const { token } = await service.sign(USER_ID, { now, ttlSeconds: 60 });
    expect(decode(token, 1)).toMatchObject({
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 60,
    });
    const viaJose = await signAccessToken(SECRET, USER_ID, { now, ttlSeconds: 60 });
    expect(decode(viaJose.token, 1)).toMatchObject({
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 60,
    });
  });

  it('reports an expired token as expired on both sides', async () => {
    const past = new Date(Date.now() - 3600_000);
    const fromService = (await service.sign(USER_ID, { now: past })).token;
    const fromJose = (await signAccessToken(SECRET, USER_ID, { now: past })).token;

    for (const token of [fromService, fromJose]) {
      await expect(service.verify(token)).rejects.toMatchObject({ reason: 'expired' });
      await expect(verifyAccessToken(token, SECRET)).rejects.toMatchObject({ reason: 'expired' });
    }
  });

  describe('rejects the same tokens on both sides', () => {
    const noneAlg = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({ sub: USER_ID, jti: 'x', aud: ACCESS_TOKEN_AUDIENCE, exp: 4_000_000_000 }),
    ).toString('base64url')}.`;

    const cases: Array<[string, () => Promise<string>]> = [
      [
        'a tampered signature',
        async () =>
          `${(await service.sign(USER_ID)).token.split('.').slice(0, 2).join('.')}.${'x'.repeat(43)}`,
      ],
      [
        'a token signed with another secret',
        async () => (await signAccessToken('another-secret-another-secret-1234', USER_ID)).token,
      ],
      [
        'another audience',
        () =>
          new JwtService({ secret: SECRET }).signAsync(
            {},
            { subject: USER_ID, jwtid: 'x', audience: 'other', expiresIn: 60 },
          ),
      ],
      [
        'another algorithm',
        () =>
          new JwtService({ secret: SECRET }).signAsync(
            {},
            {
              subject: USER_ID,
              jwtid: 'x',
              audience: ACCESS_TOKEN_AUDIENCE,
              expiresIn: 60,
              algorithm: 'HS512',
            },
          ),
      ],
      ['alg none', async () => noneAlg],
      [
        'no token id',
        () =>
          new JwtService({ secret: SECRET }).signAsync(
            {},
            { subject: USER_ID, audience: ACCESS_TOKEN_AUDIENCE, expiresIn: 60 },
          ),
      ],
      [
        'no subject',
        () =>
          new JwtService({ secret: SECRET }).signAsync(
            {},
            { jwtid: 'x', audience: ACCESS_TOKEN_AUDIENCE, expiresIn: 60 },
          ),
      ],
      [
        'no expiry',
        () =>
          new JwtService({ secret: SECRET }).signAsync(
            { sub: USER_ID, jti: 'x' },
            { audience: ACCESS_TOKEN_AUDIENCE },
          ),
      ],
      ['garbage', async () => 'not-a-jwt'],
    ];

    it.each(cases)('%s', async (_name, make) => {
      const token = await make();
      await expect(service.verify(token)).rejects.toMatchObject({ reason: 'invalid' });
      await expect(verifyAccessToken(token, SECRET)).rejects.toMatchObject({ reason: 'invalid' });
    });
  });
});
