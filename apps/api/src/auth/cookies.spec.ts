import { cookieOptions } from './cookies';

describe('cookieOptions', () => {
  it('is httpOnly, SameSite=Lax and carries path and lifetime', () => {
    expect(cookieOptions({ APP_ENV: 'dev' }, '/api/auth', 60)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/api/auth',
      maxAge: 60_000,
    });
  });

  it('is Secure in staging only', () => {
    expect(cookieOptions({ APP_ENV: 'staging' }, '/', 1).secure).toBe(true);
    expect(cookieOptions({ APP_ENV: 'dev' }, '/', 1).secure).toBe(false);
    expect(cookieOptions({ APP_ENV: 'test' }, '/', 1).secure).toBe(false);
  });
});
