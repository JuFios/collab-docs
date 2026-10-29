import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from './headers';

const env = {
  s3PublicEndpoint: 'http://localhost:9000',
  collabPublicUrl: 'ws://localhost:4001',
  development: false,
};

const directive = (policy: string, name: string) =>
  policy
    .split('; ')
    .find((part) => part.startsWith(`${name} `))
    ?.slice(name.length + 1);

describe('security headers', () => {
  it('closes the doors that no page needs', () => {
    const policy = contentSecurityPolicy(env);
    expect(directive(policy, 'default-src')).toBe("'self'");
    expect(directive(policy, 'object-src')).toBe("'none'");
    expect(directive(policy, 'base-uri')).toBe("'none'");
    expect(directive(policy, 'frame-ancestors')).toBe("'none'");
    expect(directive(policy, 'form-action')).toBe("'self'");
  });

  it('lets pages talk to object storage and the collab service, and to nobody else', () => {
    const policy = contentSecurityPolicy({
      ...env,
      s3PublicEndpoint: 'https://files.example.com/bucket',
      collabPublicUrl: 'wss://collab.example.com/ws',
    });
    expect(directive(policy, 'img-src')).toBe("'self' data: https://files.example.com");
    expect(directive(policy, 'connect-src')).toBe(
      "'self' https://files.example.com wss://collab.example.com",
    );
    expect(policy).not.toContain('*');
  });

  it('allows eval only while developing', () => {
    expect(directive(contentSecurityPolicy(env), 'script-src')).not.toContain('unsafe-eval');
    expect(directive(contentSecurityPolicy({ ...env, development: true }), 'script-src')).toContain(
      "'unsafe-eval'",
    );
  });

  it('trades unsafe-inline for the nonce and strict-dynamic on per-request pages', () => {
    const scripts = directive(contentSecurityPolicy({ ...env, nonce: 'abc123==' }), 'script-src');
    expect(scripts).toBe("'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(directive(contentSecurityPolicy(env), 'script-src')).toBe("'self' 'unsafe-inline'");
  });

  it('is sent together with the other protective headers', () => {
    const names = securityHeaders(env).map((header) => header.key);
    expect(names).toEqual(
      expect.arrayContaining([
        'Content-Security-Policy',
        'X-Content-Type-Options',
        'X-Frame-Options',
        'Referrer-Policy',
        'Permissions-Policy',
      ]),
    );
  });
});
