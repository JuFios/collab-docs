import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { ORIGIN, createDocument, createWorkspace } from '../workspace';

const editorOf = (page: Page) => page.getByRole('textbox', { name: 'Document content' });
const saveStatus = (page: Page) => page.locator('[data-testid="save-status"]:visible');

/** The api answers 404 for a page that is not published; the web page is fetched without any session. */
const pageHtml = async (request: APIRequestContext, slug: string) => {
  const response = await request.get(`/p/${slug}`);
  return { status: response.status(), body: await response.text(), headers: response.headers() };
};

async function typeInto(page: Page, text: string): Promise<void> {
  await editorOf(page).click();
  await page.keyboard.type(text);
  await expect(saveStatus(page)).toHaveText('Saved');
}

async function openEditable(page: Page, workspaceId: string, documentId: string): Promise<void> {
  await page.goto(`/w/${workspaceId}/d/${documentId}`);
  await expect(editorOf(page)).toHaveAttribute('contenteditable', 'true');
  await expect(saveStatus(page)).toHaveText('Saved');
}

async function createLink(
  page: Page,
  documentId: string,
  data: { mode: 'VIEW' | 'EDIT'; expiresAt?: string },
) {
  const response = await page.request.post(`/api/documents/${documentId}/public-links`, {
    data,
    headers: { origin: ORIGIN },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: string; slug: string | null; token: string | null };
}

test.describe('published page', () => {
  test('is server-rendered, cached, follows edits and title changes, and disappears when unpublished', async ({
    signedInPage: owner,
    request,
    browser,
    baseURL,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Publishing');
    const documentId = await createDocument(owner, workspaceId, 'Quarterly plan');
    await openEditable(owner, workspaceId, documentId);
    await typeInto(owner, 'We ship the public pages next.');

    // publish from the Share dialog
    await owner.getByRole('button', { name: 'Share' }).click();
    await owner.getByRole('button', { name: 'Publish to web' }).click();
    const address = await owner.getByLabel('Public link').inputValue();
    const slug = new URL(address).pathname.replace('/p/', '');
    expect(slug).toMatch(/^quarterly-plan-[0-9a-f]+$/);
    await owner.keyboard.press('Escape');

    // a plain HTTP client (no JavaScript, no cookies) gets the content and the meta tags in the HTML
    const first = await pageHtml(request, slug);
    expect(first.status).toBe(200);
    expect(first.body).toContain('We ship the public pages next.');
    expect(first.body).toMatch(/<title>Quarterly plan<\/title>/);
    expect(first.body).toContain(
      '<meta name="description" content="We ship the public pages next."',
    );
    expect(first.body).toContain(`<link rel="canonical" href="${ORIGIN}/p/${slug}"`);
    expect(first.body).toContain('<meta property="og:title" content="Quarterly plan"');
    expect(first.body).toContain('name="robots" content="index, follow"');
    expect(first.headers['cache-control']).toContain('s-maxage=3600');
    // nothing about the author or the workspace
    expect(first.body).not.toContain('Publishing');
    expect(first.body).not.toContain(owner.url());

    // the second request is served from the ISR cache
    const second = await pageHtml(request, slug);
    expect(second.headers['x-nextjs-cache']).toBe('HIT');

    // an edit reaches the page without a deploy: the worker invalidates the tag after the debounce
    await typeInto(owner, ' Then search.');
    await expect
      .poll(async () => (await pageHtml(request, slug)).body, { timeout: 20_000, intervals: [500] })
      .toContain('Then search.');

    // so does a new title
    const rename = await owner.request.patch(`/api/documents/${documentId}`, {
      data: { title: 'Roadmap' },
      headers: { origin: ORIGIN },
    });
    expect(rename.ok()).toBe(true);
    await expect
      .poll(async () => (await pageHtml(request, slug)).body, { timeout: 20_000, intervals: [500] })
      .toMatch(/<title>Roadmap<\/title>/);

    // unpublishing makes the page a 404 at once, although the HTML was cached
    const links = await owner.request.get(`/api/documents/${documentId}/public-links`);
    const view = ((await links.json()) as { id: string; mode: string }[]).find(
      (link) => link.mode === 'VIEW',
    );
    const revoke = await owner.request.delete(
      `/api/documents/${documentId}/public-links/${view?.id}`,
      { headers: { origin: ORIGIN } },
    );
    expect(revoke.status()).toBe(204);
    await expect
      .poll(async () => (await pageHtml(request, slug)).status, {
        timeout: 20_000,
        intervals: [500],
      })
      .toBe(404);

    // publishing again brings the same address back, although the 404 was cached
    await createLink(owner, documentId, { mode: 'VIEW' });
    await expect
      .poll(async () => (await pageHtml(request, slug)).status, {
        timeout: 20_000,
        intervals: [500],
      })
      .toBe(200);

    // the published page is not an editor: no editing surface, no textbox
    const reader = await (await browser.newContext({ baseURL })).newPage();
    await reader.goto(`/p/${slug}`);
    await expect(reader.getByRole('heading', { level: 1, name: 'Roadmap' })).toBeVisible();
    await expect(reader.getByRole('textbox')).toHaveCount(0);
    await reader.context().close();
  });

  test('shows hostile text as text and runs nothing', async ({
    signedInPage: owner,
    browser,
    baseURL,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Hostile');
    const documentId = await createDocument(owner, workspaceId, 'Payloads');
    await openEditable(owner, workspaceId, documentId);
    await typeInto(owner, '<img src=x onerror="window.__xss=1"> <script>window.__xss=2</script>');
    const { slug } = await createLink(owner, documentId, { mode: 'VIEW' });

    const visitor = await (await browser.newContext({ baseURL })).newPage();
    const dialogs: string[] = [];
    visitor.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await expect
      .poll(async () => (await visitor.goto(`/p/${slug}`))?.status(), { timeout: 20_000 })
      .toBe(200);
    await expect(visitor.getByText('window.__xss=1', { exact: false })).toBeVisible();
    // nothing ran: the payload would have set this global
    expect(await visitor.evaluate('window.__xss')).toBeUndefined();
    expect(await visitor.locator('article img[src="x"], article script').count()).toBe(0);
    expect(dialogs).toEqual([]);
    await visitor.context().close();
  });

  test('cannot be published while the editor holds changes the server has not stored', async ({
    signedInPage: owner,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Offline');
    const documentId = await createDocument(owner, workspaceId, 'Draft');
    await openEditable(owner, workspaceId, documentId);

    await owner.context().setOffline(true);
    await editorOf(owner).click();
    await owner.keyboard.type('typed while offline');
    await owner.getByRole('button', { name: 'Share' }).click();
    const publish = owner.getByRole('button', { name: 'Publish to web' });
    await expect(publish).toBeDisabled();
    await expect(owner.getByText(/You are offline/)).toBeVisible();

    await owner.context().setOffline(false);
    await expect(publish).toBeEnabled({ timeout: 30_000 });
  });
});

test.describe('edit link', () => {
  test('lets a guest edit, and stops them when the link is turned off', async ({
    signedInPage: owner,
    browser,
    baseURL,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Guests');
    const documentId = await createDocument(owner, workspaceId, 'Shared draft');
    await openEditable(owner, workspaceId, documentId);
    await typeInto(owner, 'owner text ');
    const { id, token } = await createLink(owner, documentId, { mode: 'EDIT' });

    const guest = await (await browser.newContext({ baseURL })).newPage();
    await guest.goto(`/e/${token}`);
    await expect(guest.getByText('You are editing as a guest')).toBeVisible();
    await expect(editorOf(guest)).toHaveAttribute('contenteditable', 'true');
    await expect(editorOf(guest)).toContainText('owner text');
    await expect(guest.getByRole('button', { name: 'Image' })).toHaveCount(0);
    expect(await guest.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');

    await editorOf(guest).click();
    await guest.keyboard.press('End');
    await guest.keyboard.type('guest text');
    await expect(editorOf(owner)).toContainText('guest text');
    await expect(
      owner.getByTestId('presence').getByRole('listitem', { name: /Guest/ }),
    ).toBeVisible();

    // turning the link off ends the guest's session and the address stops working
    const revoke = await owner.request.delete(`/api/documents/${documentId}/public-links/${id}`, {
      headers: { origin: ORIGIN },
    });
    expect(revoke.status()).toBe(204);
    await expect(guest.getByText('This link no longer works')).toBeVisible({ timeout: 20_000 });
    await guest.reload();
    await expect(guest.getByText('This link no longer works')).toBeVisible();
    await guest.context().close();
  });

  test('shows an explanation for an expired link and for an address that never worked', async ({
    signedInPage: owner,
    browser,
    baseURL,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Expiry');
    const documentId = await createDocument(owner, workspaceId, 'Short lived');
    const { token } = await createLink(owner, documentId, {
      mode: 'EDIT',
      expiresAt: new Date(Date.now() + 3000).toISOString(),
    });
    const visitor = await (await browser.newContext({ baseURL })).newPage();
    await owner.waitForTimeout(3500);
    await visitor.goto(`/e/${token}`);
    await expect(visitor.getByText('This link no longer works')).toBeVisible();
    await expect(visitor.getByRole('textbox')).toHaveCount(0);

    await visitor.goto(`/e/${'A'.repeat(43)}`);
    await expect(visitor.getByText('This link does not work')).toBeVisible();
    await visitor.context().close();
  });
});
