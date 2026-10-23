import { describe, expect, it } from 'vitest';
import { decideRoute, isPublicPath } from './route-policy';

describe('decideRoute', () => {
  it('lets signed-in users reach private pages', () => {
    expect(decideRoute({ pathname: '/w', search: '', session: 'valid' })).toEqual({ type: 'next' });
  });

  it.each(['expired', 'none'] as const)(
    'routes a %s session through the api refresh endpoint and keeps the target',
    (session) => {
      expect(decideRoute({ pathname: '/w/abc', search: '?tab=1', session })).toEqual({
        type: 'refresh',
        next: '/w/abc?tab=1',
      });
    },
  );

  it.each(['/', '/p/some-slug', '/e/token', '/invite/abc', '/mock-checkout/1'])(
    'keeps %s public',
    (pathname) => {
      for (const session of ['valid', 'expired', 'none'] as const) {
        expect(decideRoute({ pathname, search: '', session })).toEqual({ type: 'next' });
      }
    },
  );

  it('bounces signed-in users away from the guest-only pages', () => {
    expect(decideRoute({ pathname: '/login', search: '', session: 'valid' })).toEqual({
      type: 'redirect',
      location: '/w',
    });
    expect(
      decideRoute({ pathname: '/register', search: '?next=/w/abc', session: 'valid' }),
    ).toEqual({
      type: 'redirect',
      location: '/w/abc',
    });
  });

  it('shows the login form to users whose session is expired or missing (no refresh loop)', () => {
    expect(decideRoute({ pathname: '/login', search: '', session: 'expired' })).toEqual({
      type: 'next',
    });
    expect(decideRoute({ pathname: '/login', search: '', session: 'none' })).toEqual({
      type: 'next',
    });
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
    'ignores the unsafe next value %s for signed-in users',
    (next) => {
      expect(
        decideRoute({
          pathname: '/login',
          search: `?next=${encodeURIComponent(next)}`,
          session: 'valid',
        }),
      ).toEqual({ type: 'redirect', location: '/w' });
    },
  );
});

describe('isPublicPath', () => {
  it('treats app routes as private', () => {
    for (const path of ['/w', '/w/1/d/2', '/shared', '/notifications'])
      expect(isPublicPath(path)).toBe(false);
  });
});
