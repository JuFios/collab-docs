import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { ORIGIN, createDocument, createWorkspace, invitedMember } from '../workspace';

const editorOf = (page: Page) => page.getByRole('textbox', { name: 'Document content' });
const saveStatus = (page: Page) => page.locator('[data-testid="save-status"]:visible');
const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Comments' });

const THREADS_API =
  /^\/api\/(documents\/[0-9a-f-]{36}\/threads|threads\/[0-9a-f-]{36}\/(comments|resolve|reopen))$/;

/**
 * Runs a write on a thread and waits until the api has answered it and the panel has read the threads again. The
 * panel applies a write optimistically and then refetches; a step taken before that refetch lands can be overtaken by
 * a read that started before the write was stored, which only shows up on a slow machine.
 */
async function written(page: Page, action: () => Promise<void>): Promise<void> {
  let stored = false;
  const answered = page.waitForResponse((response) => {
    const match =
      response.request().method() === 'POST' && THREADS_API.test(new URL(response.url()).pathname);
    if (match) stored = true;
    return match;
  });
  const refetched = page.waitForResponse(
    (response) =>
      stored &&
      response.request().method() === 'GET' &&
      /\/documents\/[0-9a-f-]{36}\/threads$/.test(new URL(response.url()).pathname),
  );
  await action();
  await answered;
  await refetched;
}

async function openEditable(page: Page, workspaceId: string, documentId: string): Promise<void> {
  await page.goto(`/w/${workspaceId}/d/${documentId}`);
  await expect(editorOf(page)).toHaveAttribute('contenteditable', 'true');
  await expect(saveStatus(page)).toHaveText('Saved');
}

/** Types a paragraph and returns its block id (what a thread is anchored to). */
async function writeParagraph(page: Page, text: string): Promise<string> {
  await editorOf(page).click();
  await page.keyboard.type(text);
  await expect(saveStatus(page)).toHaveText('Saved');
  const block = editorOf(page).locator('p[data-id]', { hasText: text });
  await expect(block).toHaveAttribute('data-id', /.+/);
  return (await block.getAttribute('data-id'))!;
}

/** Starts a thread on the paragraph with the given text through the marker beside it. */
async function startThread(page: Page, text: string): Promise<void> {
  const block = editorOf(page).locator('p[data-id]', { hasText: text });
  await block.hover();
  await block.getByRole('button', { name: 'Add a comment to this block' }).click();
  await expect(panelOf(page)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'New comment' })).toBeFocused();
}

async function submitComment(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
}

test.describe('comments', () => {
  test('a mention reaches the person without a reload and leads to the thread', async ({
    browser,
    baseURL,
    signedInPage: author,
  }) => {
    const workspaceId = await createWorkspace(author, 'Mentions');
    const documentId = await createDocument(author, workspaceId, 'Review me');
    const {
      page: reader,
      context,
      name,
    } = await invitedMember(browser, baseURL, author, workspaceId, 'Editor');

    // the person to be mentioned is online in the workspace, on a page that has nothing to do with the document
    await reader.goto(`/w/${workspaceId}`);
    await expect(reader.getByTestId('notifications-bell')).toBeVisible();
    await expect(reader.getByTestId('unread-badge')).toHaveCount(0);
    await reader.evaluate(() => {
      (globalThis as { __loaded?: boolean }).__loaded = true;
    });

    await openEditable(author, workspaceId, documentId);
    await writeParagraph(author, 'The numbers in this paragraph need a second look');
    await startThread(author, 'The numbers in this paragraph');

    const field = author.getByRole('combobox', { name: 'New comment' });
    await field.pressSequentially('Could you check this, @E2E');
    await author.getByRole('option', { name: new RegExp(name) }).click();
    await field.pressSequentially('before Friday?');
    await submitComment(author, 'Comment');

    // the author sees the thread, with the mention as a name
    const thread = author.getByTestId('comment-thread');
    await expect(thread).toContainText(`Could you check this, @${name} before Friday?`);
    await expect(author.getByRole('button', { name: /1 open comment thread/ })).toBeVisible();

    // the other person: badge and toast, no navigation in between
    await expect(reader.getByTestId('unread-badge')).toHaveText('1');
    await expect(reader.getByText('mentioned you in “Review me”').first()).toBeVisible();
    // still the same page load: nothing was reloaded to get here
    expect(await reader.evaluate(() => (globalThis as { __loaded?: boolean }).__loaded)).toBe(true);

    await reader.getByTestId('notifications-bell').click();
    await reader.getByRole('menuitem', { name: /Review me/ }).click();

    await expect(reader).toHaveURL(/\/d\/[0-9a-f-]{36}\?thread=[0-9a-f-]{36}/);
    const opened = panelOf(reader).getByTestId('comment-thread');
    await expect(opened).toContainText('Could you check this');
    await expect(opened).toHaveAttribute('data-thread-id', /.+/);
    await expect(reader.getByTestId('unread-badge')).toHaveCount(0);

    // the list page shows the same notification, already read
    await reader.goto('/notifications');
    await expect(reader.getByRole('list', { name: 'Notifications' })).toContainText(
      'mentioned you in “Review me”',
    );
    await context.close();
  });

  test('a viewer reads the threads but cannot write, resolve or reply', async ({
    browser,
    baseURL,
    signedInPage: author,
  }) => {
    const workspaceId = await createWorkspace(author, 'Read only');
    const documentId = await createDocument(author, workspaceId, 'Notes');
    await openEditable(author, workspaceId, documentId);
    const blockId = await writeParagraph(author, 'A claim that needs a source');
    const created = await author.request.post(`/api/documents/${documentId}/threads`, {
      data: { blockId, body: 'Source please' },
      headers: { origin: ORIGIN },
    });
    expect(created.status(), await created.text()).toBe(201);

    const { page: viewer, context } = await invitedMember(
      browser,
      baseURL,
      author,
      workspaceId,
      'Viewer',
    );
    await viewer.goto(`/w/${workspaceId}/d/${documentId}`);
    await expect(editorOf(viewer)).toContainText('A claim that needs a source');
    // the marker shows that the block has a thread, and opens it
    await viewer.getByRole('button', { name: /1 open comment thread/ }).click();
    await expect(panelOf(viewer).getByTestId('comment-thread')).toContainText('Source please');
    await expect(viewer.getByTestId('comments-readonly')).toBeVisible();
    await expect(panelOf(viewer).getByRole('combobox')).toHaveCount(0);
    await expect(panelOf(viewer).getByRole('button', { name: /Resolve|Reply/ })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Add a comment to this block' })).toHaveCount(
      0,
    );

    // and the api agrees
    const refused = await viewer.request.post(`/api/documents/${documentId}/threads`, {
      data: { blockId, body: 'Let me in' },
      headers: { origin: ORIGIN },
    });
    expect(refused.status()).toBe(403);
    await context.close();
  });

  test('markup in a comment is shown as text and never runs', async ({ signedInPage: author }) => {
    const workspaceId = await createWorkspace(author, 'Hostile text');
    const documentId = await createDocument(author, workspaceId, 'Security');
    await openEditable(author, workspaceId, documentId);
    await writeParagraph(author, 'Anything at all');
    await startThread(author, 'Anything at all');

    const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    await author.getByRole('combobox', { name: 'New comment' }).fill(payload);
    await submitComment(author, 'Comment');

    const body = panelOf(author).getByTestId('comment-body');
    await expect(body).toHaveText(payload);
    await author.reload();
    await author.getByRole('button', { name: /Comments/ }).click();
    await expect(panelOf(author).getByTestId('comment-body')).toHaveText(payload);
    expect(await author.evaluate(() => (globalThis as { __xss?: number }).__xss)).toBeUndefined();
    await expect(panelOf(author).locator('img, script')).toHaveCount(0);
  });

  test('a thread can be replied to, resolved and reopened', async ({ signedInPage: author }) => {
    const workspaceId = await createWorkspace(author, 'Resolving');
    const documentId = await createDocument(author, workspaceId, 'Lifecycle');
    await openEditable(author, workspaceId, documentId);
    await writeParagraph(author, 'Draft sentence');
    await startThread(author, 'Draft sentence');
    await author.getByRole('combobox', { name: 'New comment' }).fill('Reword this');
    await submitComment(author, 'Comment');

    const thread = panelOf(author).getByTestId('comment-thread');
    await author.getByRole('combobox', { name: /Reply/ }).fill('Done, see below');
    await written(author, () => author.keyboard.press('Control+Enter'));
    await expect(thread).toContainText('Done, see below');

    await written(author, () => author.getByRole('button', { name: /Resolve/ }).click());
    await expect(thread).toHaveCount(0);
    await expect(author.getByRole('button', { name: /open comment thread/ })).toHaveCount(0);

    await author.getByLabel('Show resolved threads').check();
    await expect(thread).toHaveAttribute('data-resolved', 'true');
    await written(author, () => author.getByRole('button', { name: /Reopen/ }).click());
    await expect(thread).not.toHaveAttribute('data-resolved', 'true');
    await expect(author.getByRole('button', { name: /1 open comment thread/ })).toBeVisible();

    // the whole thing survives a reload
    await author.reload();
    await author.getByRole('button', { name: /Comments/ }).click();
    await expect(panelOf(author).getByTestId('comment-thread')).toContainText('Done, see below');
  });

  test('the keyboard shortcut starts a thread on the block with the caret', async ({
    signedInPage: author,
  }) => {
    const workspaceId = await createWorkspace(author, 'Shortcut');
    const documentId = await createDocument(author, workspaceId, 'Keys');
    await openEditable(author, workspaceId, documentId);
    await writeParagraph(author, 'Keyboard only');
    await author.keyboard.press('ControlOrMeta+Alt+m');
    await expect(author.getByRole('combobox', { name: 'New comment' })).toBeFocused();
    await author.keyboard.type('From the keyboard');
    await author.keyboard.press('Control+Enter');
    await expect(panelOf(author).getByTestId('comment-thread')).toContainText('From the keyboard');
    // Escape leaves the panel and gives the focus back to the button that opens it
    await author.keyboard.press('Escape');
    await expect(panelOf(author)).toHaveCount(0);
    await expect(author.getByRole('button', { name: /Comments/ })).toBeFocused();
  });
});
