import type { Page } from '@playwright/test';
import { expect, newUser, registerViaApi, test } from '../fixtures';
import { ORIGIN, createDocument, createWorkspace, invitedMember, signedIn } from '../workspace';

/** Runs `action` and waits for the matching api call to succeed, so a following reload sees persisted data. */
async function persisted(
  page: Page,
  method: string,
  path: RegExp,
  action: () => Promise<void>,
): Promise<void> {
  const done = page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      path.test(new URL(response.url()).pathname) &&
      response.ok(),
  );
  await action();
  await done;
}

/** Visible tree rows, top to bottom, as `title@level`. */
async function rows(page: Page): Promise<string[]> {
  return page
    .getByRole('treeitem')
    .evaluateAll((items) =>
      items.map((item) => `${item.getAttribute('aria-label')}@${item.getAttribute('aria-level')}`),
    );
}

test.describe('document tree', () => {
  test('creating a document opens it with the title selected, and the title is saved', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Tree');
    await expect(page.getByText('The workspace is empty.')).toBeVisible();

    await page.getByRole('button', { name: 'New document' }).click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/documents/[0-9a-f-]{36}$`));
    const title = page.getByRole('textbox', { name: 'Document title' });
    await expect(title).toBeFocused();
    await expect(title).toHaveValue('Untitled');

    await page.keyboard.type('Project plan');
    await persisted(page, 'PATCH', /\/documents\/[0-9a-f-]{36}$/, () =>
      page.keyboard.press('Enter'),
    );
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'Project plan' })).toBeVisible();

    await page.reload();
    await expect(title).toHaveValue('Project plan');
    // the tab names the document
    await expect(page).toHaveTitle('Project plan · Collab Docs');
    await expect(page.getByRole('treeitem', { name: 'Project plan' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(
      page.getByRole('article').getByRole('textbox', { name: 'Document content' }),
    ).toBeVisible();
  });

  test('a node moves by dragging and the order survives a reload', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Dnd');
    await createDocument(page, workspaceId, 'Alpha');
    await createDocument(page, workspaceId, 'Beta');
    await createDocument(page, workspaceId, 'Gamma');
    await page.goto(`/workspaces/${workspaceId}`);
    expect(await rows(page)).toEqual(['Alpha@1', 'Beta@1', 'Gamma@1']);

    const handle = page.getByRole('button', { name: 'Drag Gamma' });
    const target = page.getByRole('treeitem', { name: 'Alpha' });
    await page.getByRole('treeitem', { name: 'Gamma' }).hover();
    const from = (await handle.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // upper quarter of the row = "before", middle = "inside"
    await page.mouse.move(to.x + 40, to.y + 2, { steps: 8 });
    await expect(target).toHaveAttribute('data-drop-zone', 'before');
    await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 4 });
    await expect(target).toHaveAttribute('data-drop-zone', 'inside');
    await page.mouse.move(to.x + 40, to.y + 2, { steps: 4 });
    await persisted(page, 'POST', /\/documents\/[0-9a-f-]{36}\/move$/, () => page.mouse.up());

    await expect.poll(() => rows(page)).toEqual(['Gamma@1', 'Alpha@1', 'Beta@1']);
    await page.reload();
    expect(await rows(page)).toEqual(['Gamma@1', 'Alpha@1', 'Beta@1']);

    // and nested: drop Beta into the middle of Gamma
    const betaHandle = page.getByRole('button', { name: 'Drag Beta' });
    await page.getByRole('treeitem', { name: 'Beta' }).hover();
    const betaBox = (await betaHandle.boundingBox())!;
    const gamma = (await page.getByRole('treeitem', { name: 'Gamma' }).boundingBox())!;
    await page.mouse.move(betaBox.x + betaBox.width / 2, betaBox.y + betaBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gamma.x + 40, gamma.y + gamma.height / 2, { steps: 10 });
    await persisted(page, 'POST', /\/documents\/[0-9a-f-]{36}\/move$/, () => page.mouse.up());
    await expect.poll(() => rows(page)).toEqual(['Gamma@1', 'Beta@2', 'Alpha@1']);
    await page.reload();
    expect(await rows(page)).toEqual(['Gamma@1', 'Beta@2', 'Alpha@1']);
  });

  test('the keyboard reorders, indents and renames', async ({ signedInPage: page }) => {
    const workspaceId = await createWorkspace(page, 'Keys');
    await createDocument(page, workspaceId, 'One');
    await createDocument(page, workspaceId, 'Two');
    await page.goto(`/workspaces/${workspaceId}`);

    await page.getByRole('treeitem', { name: 'Two' }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => rows(page)).toEqual(['Two@1', 'One@1']);
    await expect(page.getByRole('treeitem', { name: 'Two' })).toBeFocused();

    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => rows(page)).toEqual(['One@1', 'Two@1']);
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => rows(page)).toEqual(['One@1', 'Two@2']);
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(() => rows(page)).toEqual(['One@1', 'Two@1']);

    await page.keyboard.press('F2');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Second');
    await persisted(page, 'PATCH', /\/documents\/[0-9a-f-]{36}$/, () =>
      page.keyboard.press('Enter'),
    );
    await expect(page.getByRole('treeitem', { name: 'Second' })).toBeVisible();
    await page.reload();
    expect(await rows(page)).toEqual(['One@1', 'Second@1']);
  });

  test('Rename in the row menu edits the title in place and keeps the field open', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Row menu');
    await createDocument(page, workspaceId, 'Old name');
    await page.goto(`/workspaces/${workspaceId}`);

    await page.getByRole('treeitem', { name: 'Old name' }).hover();
    await page.getByRole('button', { name: 'Actions for Old name' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    // the menu hands focus back when it closes; that must not end the rename
    const field = page.getByRole('treeitem').getByRole('textbox', { name: 'Document title' });
    await expect(field).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('New name');
    await persisted(page, 'PATCH', /\/documents\/[0-9a-f-]{36}$/, () =>
      page.keyboard.press('Enter'),
    );
    await expect(page.getByRole('treeitem', { name: 'New name' })).toBeVisible();
    await expect(page.getByRole('treeitem')).toHaveCount(1);
  });

  test('Rename in the document menu moves the cursor to the title', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Page menu');
    const id = await createDocument(page, workspaceId, 'Before');
    await page.goto(`/workspaces/${workspaceId}/documents/${id}`);
    const title = page.getByRole('textbox', { name: 'Document title' });
    await expect(title).toHaveValue('Before');

    await page.getByRole('button', { name: 'Document actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await expect(title).toBeFocused();
    await page.keyboard.type('After');
    await persisted(page, 'PATCH', /\/documents\/[0-9a-f-]{36}$/, () =>
      page.keyboard.press('Enter'),
    );
    await expect(page.getByRole('treeitem', { name: 'After' })).toBeVisible();
  });

  test('Copy link puts the address of the document on the clipboard', async ({
    signedInPage: page,
  }) => {
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    const workspaceId = await createWorkspace(page, 'Copy');
    const id = await createDocument(page, workspaceId, 'Copied');
    await page.goto(`/workspaces/${workspaceId}/documents/${id}`);

    await page.getByRole('button', { name: 'Document actions' }).click();
    await page.getByRole('menuitem', { name: 'Copy link' }).click();
    await expect(page.getByText('Link copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${ORIGIN}/workspaces/${workspaceId}/documents/${id}`,
    );
  });

  test('cancelling the trash dialog opened from the tree returns to the row', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Row focus');
    await createDocument(page, workspaceId, 'Kept');
    await page.goto(`/workspaces/${workspaceId}`);

    await page.getByRole('treeitem', { name: 'Kept' }).focus();
    await page.keyboard.press('Delete');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('treeitem', { name: 'Kept' })).toBeFocused();
  });

  test('cancelling the trash dialog returns to the menu button', async ({ signedInPage: page }) => {
    const workspaceId = await createWorkspace(page, 'Cancel trash');
    const id = await createDocument(page, workspaceId, 'Stays');
    await page.goto(`/workspaces/${workspaceId}/documents/${id}`);

    await page.getByRole('button', { name: 'Document actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to trash' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Document actions' })).toBeFocused();
  });

  test('a node created in one window appears in another without a reload', async ({
    browser,
    baseURL,
    user,
    signedInPage: first,
  }) => {
    const workspaceId = await createWorkspace(first, 'Live');
    const { page: second, context } = await signedIn(browser, baseURL, user);
    await second.goto(`/workspaces/${workspaceId}`);
    await expect(second.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
    await expect(second.getByRole('treeitem')).toHaveCount(0);

    await createDocument(first, workspaceId, 'Shared note');
    await expect(second.getByRole('treeitem', { name: 'Shared note' })).toBeVisible();

    // a rename made in the first window reaches the second one too
    await first.goto(`/workspaces/${workspaceId}`);
    await first.getByRole('treeitem', { name: 'Shared note' }).focus();
    await first.keyboard.press('F2');
    await first.keyboard.press('ControlOrMeta+a');
    await first.keyboard.type('Renamed note');
    await first.keyboard.press('Enter');
    await expect(second.getByRole('treeitem', { name: 'Renamed note' })).toBeVisible();
    await context.close();
  });

  test('deleting asks first, lands in the trash and can be restored', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Trash');
    const parent = await createDocument(page, workspaceId, 'Parent');
    await createDocument(page, workspaceId, 'Child', parent);
    await page.goto(`/workspaces/${workspaceId}/documents/${parent}`);

    await page.getByRole('treeitem', { name: 'Parent' }).hover();
    await page.getByRole('button', { name: 'Actions for Parent' }).click();
    await page.getByRole('menuitem', { name: 'Move to trash' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('1 subpage');
    await dialog.getByRole('button', { name: 'Move to trash' }).click();

    // the open document was deleted: we are taken to the workspace and the tree is empty
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}$`));
    await expect(page.getByRole('treeitem')).toHaveCount(0);

    await page.goto(`/workspaces/${workspaceId}/documents/${parent}`);
    await expect(page.getByRole('heading', { name: 'This document was deleted' })).toBeVisible();

    await page.goto(`/workspaces/${workspaceId}/trash`);
    const entry = page.getByRole('listitem').filter({ hasText: 'Parent' });
    await expect(entry).toContainText('with 1 subpages');
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'Parent' })).toBeVisible();
    await page.getByRole('button', { name: 'Expand Parent' }).click();
    await expect(page.getByRole('treeitem', { name: 'Child' })).toBeVisible();
  });

  test('the pages beside the tree follow a deletion and a rename made in it', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Beside');
    await createDocument(page, workspaceId, 'Doomed');
    await createDocument(page, workspaceId, 'Renamed');

    await page.goto(`/workspaces/${workspaceId}`);
    const recent = page.getByRole('region', { name: 'Recent documents' });
    await expect(recent).toContainText('Renamed');
    await page.getByRole('treeitem', { name: 'Renamed' }).focus();
    await page.keyboard.press('F2');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Now called this');
    await page.keyboard.press('Enter');
    await expect(recent).toContainText('Now called this');

    await page.goto(`/workspaces/${workspaceId}/trash`);
    await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible();
    await page.getByRole('treeitem', { name: 'Doomed' }).hover();
    await page.getByRole('button', { name: 'Actions for Doomed' }).click();
    await page.getByRole('menuitem', { name: 'Move to trash' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click();
    await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The trash is empty' })).toHaveCount(0);
  });

  test('a viewer reads but cannot change anything; a stranger gets not-found', async ({
    browser,
    baseURL,
    signedInPage: owner,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Roles');
    const docId = await createDocument(owner, workspaceId, 'Handbook');
    const { page: viewer } = await invitedMember(browser, baseURL, owner, workspaceId, 'Viewer');

    await viewer.goto(`/workspaces/${workspaceId}/documents/${docId}`);
    await expect(viewer.getByRole('heading', { name: 'Handbook', level: 2 })).toBeVisible();
    await expect(viewer.getByRole('article').getByText('Read-only')).toBeVisible();
    await expect(viewer.getByRole('textbox', { name: 'Document title' })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'New document' })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: /^Drag/ })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Document actions' })).toHaveCount(0);

    const stranger = await registerViaApi(
      (await browser.newContext({ baseURL })).request,
      newUser('stranger'),
    );
    const { page: outsider } = await signedIn(browser, baseURL, stranger);
    await outsider.goto(`/workspaces/${workspaceId}/documents/${docId}`);
    await expect(outsider.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await outsider.goto(`/workspaces/${workspaceId}/trash`);
    await expect(outsider.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });

  test('a guest opens a shared document from the shared list, without the workspace frame', async ({
    browser,
    baseURL,
    signedInPage: owner,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Guests');
    const docId = await createDocument(owner, workspaceId, 'For guests');
    const guest = await registerViaApi(
      (await browser.newContext({ baseURL })).request,
      newUser('guest'),
    );
    const share = await owner.request.post(`/api/documents/${docId}/shares`, {
      data: { email: guest.email, role: 'VIEWER' },
      headers: { origin: ORIGIN },
    });
    expect(share.status(), await share.text()).toBe(201);

    const { page } = await signedIn(browser, baseURL, guest);
    await page.goto('/shared');
    await page.getByRole('link', { name: /For guests/ }).click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/documents/${docId}$`));
    await expect(page.getByRole('heading', { name: 'For guests', level: 2 })).toBeVisible();
    await expect(page.getByRole('article').getByText('Read-only')).toBeVisible();
    await expect(page.getByRole('tree')).toHaveCount(0);

    await page.goto(`/workspaces/${workspaceId}`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });

  test('the shared list and the trash have empty states', async ({ signedInPage: page }) => {
    await page.goto('/shared');
    await expect(page.getByText('Nothing has been shared with you')).toBeVisible();
    const workspaceId = await createWorkspace(page, 'Empty');
    await page.goto(`/workspaces/${workspaceId}/trash`);
    await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible();
  });

  test('on a phone the tree is behind a toggle and the page does not scroll sideways', async ({
    signedInPage: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const workspaceId = await createWorkspace(page, 'Phone');
    const docId = await createDocument(
      page,
      workspaceId,
      'A rather long title for a narrow screen',
    );
    await page.goto(`/workspaces/${workspaceId}/documents/${docId}`);
    await expect(page.getByRole('textbox', { name: 'Document title' })).toBeVisible();
    // the wide parts of the page (header row, document column) must end inside the 390px viewport
    for (const part of [page.locator('header').first(), page.getByRole('article')]) {
      const box = await part.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }

    await expect(page.getByRole('tree')).toBeHidden();
    await page.getByRole('button', { name: 'Documents' }).click();
    await expect(page.getByRole('treeitem', { name: /A rather long title/ })).toBeVisible();
  });
});
