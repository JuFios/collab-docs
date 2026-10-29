import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { createDocument, createWorkspace } from '../workspace';

const editorOf = (page: Page) => page.getByRole('textbox', { name: 'Document content' });
const saveStatus = (page: Page) => page.locator('[data-testid="save-status"]:visible');
/** The query client retries a failing read twice with a growing delay before it shows the error. */
const ERROR_TIMEOUT = 15_000;

/** Makes the api answer 500 to the matching requests until `recover()` is called. */
async function failing(page: Page, url: RegExp) {
  let broken = true;
  await page.route(url, (route) =>
    broken
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Test outage' }),
        })
      : route.fallback(),
  );
  return {
    recover() {
      broken = false;
    },
  };
}

async function openEditable(page: Page, workspaceId: string, documentId: string): Promise<void> {
  await page.goto(`/workspaces/${workspaceId}/documents/${documentId}`);
  await expect(editorOf(page)).toHaveAttribute('contenteditable', 'true');
  await expect(saveStatus(page)).toHaveText('Saved');
}

// Each client-side panel reads its own data, so each has to say when that read failed and offer a way back.
test.describe('a panel whose data cannot be read', () => {
  test('the version history shows the error and recovers on "Try again"', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Outage');
    const documentId = await createDocument(page, workspaceId, 'Handbook');
    const outage = await failing(page, /\/api\/documents\/[0-9a-f-]{36}\/versions$/);
    await openEditable(page, workspaceId, documentId);

    await page.getByRole('button', { name: 'History', exact: true }).click();
    const panel = page.getByTestId('versions-panel');
    await expect(panel.getByText('Loading versions…')).toBeVisible();
    await expect(panel.getByRole('alert')).toContainText('Could not load the version history.', {
      timeout: ERROR_TIMEOUT,
    });

    outage.recover();
    await panel.getByRole('button', { name: 'Try again' }).click();
    // opening the document has already taken an automatic snapshot, so the list is not empty
    await expect(panel.getByRole('listitem').first()).toBeVisible();
    await expect(panel.getByRole('alert')).toHaveCount(0);
  });

  test('the comments panel shows the error and recovers on "Try again"', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Outage');
    const documentId = await createDocument(page, workspaceId, 'Minutes');
    await openEditable(page, workspaceId, documentId);
    await editorOf(page).click();
    await page.keyboard.type('anchor');
    await expect(saveStatus(page)).toHaveText('Saved');

    const outage = await failing(page, /\/api\/documents\/[0-9a-f-]{36}\/threads(\?.*)?$/);
    await page.reload();
    await expect(editorOf(page)).toHaveAttribute('contenteditable', 'true');
    const block = editorOf(page).locator('p[data-id]', { hasText: 'anchor' });
    await block.hover();
    await block.getByRole('button', { name: 'Add a comment to this block' }).click();

    const panel = page.getByRole('complementary', { name: 'Comments' });
    await expect(panel.getByRole('alert')).toContainText('Could not load the comments.', {
      timeout: ERROR_TIMEOUT,
    });

    outage.recover();
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel.getByText('No comments yet', { exact: false })).toBeVisible();
  });

  test('the notification menu shows the error and recovers on "Try again"', async ({
    signedInPage: page,
  }) => {
    await createWorkspace(page, 'Outage');
    const outage = await failing(page, /\/api\/notifications(\?.*)?$/);
    await page.reload();

    await page.getByRole('button', { name: /^Notifications/ }).click();
    const menu = page.getByRole('menu');
    // a menu may hold only items, labels and separators: the error is a label, the retry an item
    await expect(menu.getByText('Could not load notifications.')).toBeVisible({
      timeout: ERROR_TIMEOUT,
    });

    outage.recover();
    await menu.getByRole('menuitem', { name: 'Try again' }).click();
    await expect(menu.getByText('all caught up')).toBeVisible();
  });
});
