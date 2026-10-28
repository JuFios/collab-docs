import { describe, expect, it } from 'vitest';
import { decideRoute, isPublicPath } from './route-policy';

describe('decideRoute', () => {
  it('lets signed-in users reach private pages', () => {
    expect(decideRoute({ pathname: '/workspaces', search: '', session: 'valid' })).toEqual({
      type: 'next',
    });
  });

  it.each(['expired', 'none'] as const)(
    'routes a %s session through the api refresh endpoint and keeps the target',
    (session) => {
      expect(decideRoute({ pathname: '/workspaces/abc', search: '?tab=1', session })).toEqual({
        type: 'refresh',
        next: '/workspaces/abc?tab=1',
      });
    },
  );

  it.each(['/published/some-slug', '/edit-link/token', '/invite/abc', '/mock-checkout/1'])(
    'keeps %s public',
    (pathname) => {
      for (const session of ['valid', 'expired', 'none'] as const) {
        expect(decideRoute({ pathname, search: '', session })).toEqual({ type: 'next' });
      }
    },
  );

  it('shows the landing page to everyone but a signed-in visitor, who goes to the workspaces', () => {
    for (const session of ['expired', 'none'] as const) {
      expect(decideRoute({ pathname: '/', search: '', session })).toEqual({ type: 'next' });
    }
    expect(decideRoute({ pathname: '/', search: '', session: 'valid' })).toEqual({
      type: 'redirect',
      location: '/workspaces',
    });
  });

  it('bounces signed-in users away from the guest-only pages', () => {
    expect(decideRoute({ pathname: '/login', search: '', session: 'valid' })).toEqual({
      type: 'redirect',
      location: '/workspaces',
    });
    expect(
      decideRoute({ pathname: '/register', search: '?next=/workspaces/abc', session: 'valid' }),
    ).toEqual({
      type: 'redirect',
      location: '/workspaces/abc',
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
      ).toEqual({ type: 'redirect', location: '/workspaces' });
    },
  );
});

describe('isPublicPath', () => {
  it('treats app routes as private', () => {
    for (const path of ['/workspaces', '/workspaces/1/documents/2', '/shared', '/notifications'])
      expect(isPublicPath(path)).toBe(false);
  });
});
