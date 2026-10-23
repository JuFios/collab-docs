import { describe, expect, it } from 'vitest';
import { parseSetCookie, parseSetCookies } from './set-cookie';

describe('parseSetCookie', () => {
  it('reads the attributes the api sets', () => {
    expect(
      parseSetCookie(
        'cd_rt=abc%3D%3D; Max-Age=2592000; Path=/api/auth; Expires=Sat, 21 Nov 2026 10:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
      ),
    ).toEqual({
      name: 'cd_rt',
      value: 'abc==',
      maxAge: 2592000,
      path: '/api/auth',
      expires: new Date('Sat, 21 Nov 2026 10:00:00 GMT'),
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });

  it('keeps values that are not URI-encoded and ignores unknown attributes', () => {
    expect(parseSetCookie('a=100%; Priority=High')).toEqual({ name: 'a', value: '100%' });
  });

  it('rejects malformed headers', () => {
    expect(parseSetCookie('')).toBeUndefined();
    expect(parseSetCookie('=value')).toBeUndefined();
    expect(parseSetCookie('novalue')).toBeUndefined();
  });

  it('reads every Set-Cookie header of a response', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'cd_at=one; Path=/; HttpOnly');
    headers.append('set-cookie', 'cd_rt=two; Path=/api/auth; HttpOnly');
    expect(parseSetCookies(headers).map((c) => [c.name, c.path])).toEqual([
      ['cd_at', '/'],
      ['cd_rt', '/api/auth'],
    ]);
  });
});
