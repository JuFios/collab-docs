import { expect, test } from '@playwright/test';
import { test as signedInTest, expect as signedInExpect, watchPolicyViolations } from '../fixtures';
import { ORIGIN, createDocument, createWorkspace } from '../workspace';

const directive = (policy: string, name: string) =>
  policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `))
    ?.slice(name.length + 1);

test.describe('response headers', () => {
  test('every page carries the Content-Security-Policy and the other protective headers', async ({
    request,
  }) => {
    for (const path of ['/login', '/register']) {
      const response = await request.get(path);
      const headers = response.headers();
      const policy = headers['content-security-policy'] ?? '';
      expect(directive(policy, 'default-src'), path).toBe("'self'");
      expect(directive(policy, 'object-src')).toBe("'none'");
      expect(directive(policy, 'base-uri')).toBe("'none'");
      expect(directive(policy, 'frame-ancestors')).toBe("'none'");
      expect(directive(policy, 'form-action')).toBe("'self'");
      expect(directive(policy, 'img-src')).toContain('data:');
      expect(directive(policy, 'connect-src')).toContain('ws://localhost:4001');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(headers['permissions-policy']).toContain('camera=()');
      // the dev stack is not staging: no HSTS on a plain-HTTP origin
      expect(headers['strict-transport-security']).toBeUndefined();
    }
  });

  test('a page that the policy forbids to load a third-party script is reported by the browser', async ({
    page,
  }) => {
    // proves that the violation watcher used by the other specs can see what it is meant to see
    const violations = watchPolicyViolations(page);
    await page.goto('/login');
    await page.evaluate(
      "document.head.append(Object.assign(document.createElement('script'), { src: 'https://scripts.invalid/payload.js' }))",
    );
    await expect.poll(() => violations.length).toBeGreaterThan(0);
  });
});

test.describe('middleware is not the security boundary', () => {
  // CVE-2025-29927: this header told Next to skip middleware. Nothing private may hang on middleware alone.
  const SKIP_MIDDLEWARE = [
    'middleware',
    'middleware:middleware:middleware:middleware:middleware',
    'src/middleware:src/middleware:src/middleware:src/middleware:src/middleware',
  ];

  test('x-middleware-subrequest gives a visitor without a session neither pages nor data', async ({
    request,
  }) => {
    for (const value of SKIP_MIDDLEWARE) {
      const headers = { 'x-middleware-subrequest': value };
      const page = await request.get('/w', { headers, maxRedirects: 0 });
      const body = await page.text();
      // a redirect to sign in; and if middleware were skipped, the page must still not contain a workspace
      expect([200, 307, 308, 401, 403, 404]).toContain(page.status());
      expect(body).not.toContain('Create workspace');
      const data = await request.get('/api/workspaces', { headers });
      expect(data.status()).toBe(401);
      expect(((await data.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    }
  });

  test('a private page without a session sends the visitor to sign in', async ({ request }) => {
    const response = await request.get('/w', { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers().location).toContain('/api/auth/refresh');
  });
});

signedInTest.describe('cross-site requests', () => {
  signedInTest(
    'a state-changing request from another origin is rejected, with or without the session cookie',
    async ({ signedInPage }) => {
      const workspaceId = await createWorkspace(signedInPage, 'Cross-site');
      const documentId = await createDocument(signedInPage, workspaceId, 'Private');
      const request = signedInPage.request;

      for (const origin of ['https://evil.example', 'null']) {
        const post = await request.post('/api/workspaces', {
          data: { name: 'Forged' },
          headers: { origin },
        });
        signedInExpect(post.status(), origin).toBe(403);
        signedInExpect(((await post.json()) as { code: string }).code).toBe('CSRF_REJECTED');
        const del = await request.delete(`/api/documents/${documentId}`, { headers: { origin } });
        signedInExpect(del.status()).toBe(403);
      }
      // no Origin at all (a form post from a page that hides it) is not accepted either
      const bare = await request.post('/api/workspaces', { data: { name: 'Forged' } });
      signedInExpect(bare.status()).toBe(403);

      // the real origin still works, and nothing was created or deleted by the forged requests
      const fine = await request.delete(`/api/documents/${documentId}`, {
        headers: { origin: ORIGIN },
      });
      signedInExpect(fine.status()).toBe(204);
    },
  );
});
