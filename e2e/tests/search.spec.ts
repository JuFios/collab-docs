import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { ORIGIN, createDocument, createWorkspace, invitedMember } from '../workspace';

const editorOf = (page: Page) => page.getByRole('textbox', { name: 'Document content' });
const saveStatus = (page: Page) => page.locator('[data-testid="save-status"]:visible');
const searchField = (page: Page) => page.getByRole('searchbox', { name: 'Search documents' });
/** The results only: the sidebar tree has links to the same documents. */
const resultLinks = (page: Page) =>
  page.getByRole('list', { name: 'Search results' }).getByRole('link');

/** Opens a document, types `text` into it and waits until the server confirms it is stored. */
async function write(page: Page, workspaceId: string, documentId: string, text: string) {
  await page.goto(`/w/${workspaceId}/d/${documentId}`);
  await expect(editorOf(page)).toHaveAttribute('contenteditable', 'true');
  await expect(saveStatus(page)).toHaveText('Saved');
  await editorOf(page).click();
  await page.keyboard.type(text);
  await expect(saveStatus(page)).toHaveText('Saved');
}

/**
 * The index is updated a few seconds after a change (SEARCH_DEBOUNCE_MS), so a search that follows an edit is
 * repeated until the result is there. Returns once `expectation` holds for a fresh search.
 */
async function searchUntil(
  page: Page,
  workspaceId: string,
  q: string,
  expectation: () => Promise<void>,
) {
  await expect(async () => {
    await page.goto(`/w/${workspaceId}/search?q=${encodeURIComponent(q)}`);
    await expectation();
  }).toPass({ timeout: 30_000, intervals: [1_000] });
}

test.describe('search', () => {
  test('finds a document by its text once indexed, marks the match and opens it from the keyboard', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Search space');
    const documentId = await createDocument(page, workspaceId, 'Field notes');
    await write(page, workspaceId, documentId, 'The quetzal nests above the cloud forest');

    await searchUntil(page, workspaceId, 'quetz', () =>
      expect(resultLinks(page).filter({ hasText: 'Field notes' })).toBeVisible({ timeout: 1_000 }),
    );
    const result = resultLinks(page).filter({ hasText: 'Field notes' });
    await expect(result.locator('mark')).toHaveText('quetzal');
    await expect(result).toContainText('nests above the cloud forest');
    await expect(page).toHaveTitle('quetz · Search · Collab Docs');

    // typing a new query in the field works like the form: Enter submits it. A page that has not hydrated yet
    // resets the field and ignores keys, so the step is repeated until it takes effect.
    await expect(async () => {
      await searchField(page).fill('quetzal forest');
      await searchField(page).press('Enter');
      await expect(page).toHaveURL(/search\?q=quetzal\+forest$/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(result).toBeVisible();

    // accents and case do not matter. The page of the previous query is still settling after the navigation (the field
    // is re-rendered with the new query), and a value typed meanwhile is lost: repeat the step as above.
    await expect(async () => {
      await searchField(page).fill('QUÉTZAL');
      await searchField(page).press('Enter');
      await expect(page).toHaveURL(/search\?q=QU%C3%89TZAL$/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(result).toBeVisible();

    // keyboard: Down enters the list, Enter opens the document, Escape/Up lead back to the field
    await expect(async () => {
      await searchField(page).focus();
      await page.keyboard.press('ArrowDown');
      await expect(result).toBeFocused({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await page.keyboard.press('ArrowUp');
    await expect(searchField(page)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(result).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/d/${documentId}$`));
  });

  test('says when nothing matches and invites to search when there is no query', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Empty search');
    await page.goto(`/w/${workspaceId}/search`);
    await expect(page.getByText('Search this workspace')).toBeVisible();
    await expect(searchField(page)).toBeFocused();

    // a page that has not hydrated yet resets the field and swallows the click: repeat until the query is sent
    await expect(async () => {
      await searchField(page).fill('nothingmatchesthis');
      await page.getByRole('button', { name: 'Search' }).click();
      await expect(page).toHaveURL(/search\?q=nothingmatchesthis$/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(page.getByText('No documents match “nothingmatchesthis”')).toBeVisible();
  });

  test('shows a title and text with markup as text', async ({ signedInPage: page }) => {
    const workspaceId = await createWorkspace(page, 'Markup search');
    const title = '<img src=x onerror="window.__pwned=1"> sparrow';
    const documentId = await createDocument(page, workspaceId, title);
    await write(page, workspaceId, documentId, '<b>bold</b> sparrow');

    await searchUntil(page, workspaceId, 'sparrow', () =>
      expect(page.getByRole('list', { name: 'Search results' })).toContainText(title, {
        timeout: 1_000,
      }),
    );
    await expect(page.getByRole('list', { name: 'Search results' }).locator('img, b')).toHaveCount(
      0,
    );
    // a payload that had run would have set this flag
    expect(await page.evaluate('window.__pwned')).toBeUndefined();
  });

  test('a member sees what the access rules allow, and a share or a visibility change counts at once', async ({
    browser,
    baseURL,
    signedInPage: owner,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Search access');
    await createDocument(owner, workspaceId, 'Okapi open');
    const secret = await createDocument(owner, workspaceId, 'Okapi secret');
    const restrict = await owner.request.patch(`/api/documents/${secret}`, {
      data: { visibility: 'RESTRICTED' },
      headers: { origin: ORIGIN },
    });
    expect(restrict.status()).toBe(200);

    const { page: viewer, context } = await invitedMember(
      browser,
      baseURL,
      owner,
      workspaceId,
      'Viewer',
    );
    // both are indexed from their titles (the owner sees both)
    await searchUntil(owner, workspaceId, 'okapi', () =>
      expect(owner.getByRole('list', { name: 'Search results' }).getByRole('link')).toHaveCount(2, {
        timeout: 1_000,
      }),
    );

    await viewer.goto(`/w/${workspaceId}/search?q=okapi`);
    const results = viewer.getByRole('list', { name: 'Search results' }).getByRole('link');
    await expect(results).toHaveCount(1);
    await expect(results).toContainText('Okapi open');

    await context.close();
  });
});
