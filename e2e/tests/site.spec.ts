import { expect, test } from '../fixtures';

test.describe('site files', () => {
  test('robots.txt lets published pages be found and keeps the private ones out of the index', async ({
    request,
  }) => {
    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain('Allow: /published/');
    for (const path of ['/workspaces/', '/edit-link/', '/invite/', '/api/']) {
      expect(body).toContain(`Disallow: ${path}`);
    }
  });

  test('the site has an icon, and a visitor is not sent to the login page to fetch it', async ({
    page,
    request,
  }) => {
    await page.goto('/login');
    const href = await page.locator('link[rel="icon"]').first().getAttribute('href');
    expect(href).toMatch(/icon\.svg/);
    const response = await request.get('/icon.svg', { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/svg+xml');
  });
});
