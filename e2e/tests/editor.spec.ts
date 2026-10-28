import type { Page, WebSocketRoute } from '@playwright/test';
import { connectRaw } from '../collab-client';
import { expect, test } from '../fixtures';
import { logsOf } from '../logs';
import { ORIGIN, createDocument, createWorkspace, invitedMember } from '../workspace';

const editorOf = (page: Page) => page.getByRole('textbox', { name: 'Document content' });
/** The single save/connection status of the document header. */
// `:visible` because streaming leaves a hidden copy of a boundary in the DOM until React reveals it
const saveStatus = (page: Page) => page.locator('[data-testid="save-status"]:visible');
/**
 * Block texts joined by newlines. `innerText` is not used: a remote cursor at the end of a paragraph makes
 * ProseMirror add a separator image and a break there, which turns into an extra newline.
 */
const textOf = (page: Page) =>
  editorOf(page).evaluate((root) =>
    [...root.children].map((block) => block.textContent ?? '').join('\n'),
  );

/**
 * Puts the caret into the `index`-th top-level block, `offset` characters from its start (or at its end). Keys such
 * as Home and End do not move the caret the same way on every platform, and the tests run on more than one.
 */
async function placeCaret(page: Page, index: number, offset: number | 'end'): Promise<void> {
  await editorOf(page)
    .locator(':scope > *')
    .nth(index)
    .evaluate((block, target) => {
      const texts: Text[] = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
      let remaining = target === 'end' ? Number.POSITIVE_INFINITY : target;
      const range = document.createRange();
      range.selectNodeContents(block);
      range.collapse(false);
      for (const text of texts) {
        if (remaining <= text.length) {
          range.setStart(text, remaining);
          range.collapse(true);
          break;
        }
        remaining -= text.length;
      }
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, offset);
}

async function openDocument(page: Page, workspaceId: string, documentId: string): Promise<void> {
  await page.goto(`/workspaces/${workspaceId}/documents/${documentId}`);
  await expect(editorOf(page)).toBeVisible();
}

async function openEditable(page: Page, workspaceId: string, documentId: string): Promise<void> {
  await openDocument(page, workspaceId, documentId);
  await expect(editorOf(page)).toHaveAttribute('contenteditable', 'true');
  await expect(saveStatus(page)).toHaveText('Saved');
}

/** Lets a test cut the page's collab socket without touching the server. */
async function controllableSocket(page: Page) {
  const open: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
    server.onClose((code, reason) => void ws.close({ code, reason }));
    open.push(ws);
  });
  return {
    async cut() {
      await Promise.all(open.splice(0).map((ws) => ws.close()));
    },
  };
}

test.describe('viewer access', () => {
  test('a viewer reads the document but cannot change it, in the UI or over the wire', async ({
    browser,
    baseURL,
    signedInPage: owner,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Viewer rules');
    const documentId = await createDocument(owner, workspaceId, 'Handbook');
    await openEditable(owner, workspaceId, documentId);
    await editorOf(owner).click();
    await owner.keyboard.type('Original text');
    await expect(saveStatus(owner)).toHaveText('Saved');
    // a version for the viewer to try to restore
    const saved = await owner.request.post(`/api/documents/${documentId}/versions`, {
      data: { label: 'checkpoint' },
      headers: { origin: ORIGIN },
    });
    expect(saved.status(), await saved.text()).toBe(201);
    const { id: versionId } = (await saved.json()) as { id: string };

    const { page: viewer, context } = await invitedMember(
      browser,
      baseURL,
      owner,
      workspaceId,
      'Viewer',
    );
    await openDocument(viewer, workspaceId, documentId);

    // UI: readable, read-only, no editing controls
    await expect(editorOf(viewer)).toContainText('Original text');
    await expect(editorOf(viewer)).toHaveAttribute('contenteditable', 'false');
    await expect(viewer.getByRole('article').getByText('Read-only')).toBeVisible();
    await expect(viewer.getByRole('toolbar')).toHaveCount(0);
    await expect(viewer.getByRole('textbox', { name: 'Document title' })).toHaveCount(0);
    await editorOf(viewer).click();
    await viewer.keyboard.type('viewer typing');
    await expect(editorOf(viewer)).not.toContainText('viewer typing');

    // the history is readable, but offers neither saving nor restoring; sharing is not offered at all
    await expect(viewer.getByRole('button', { name: 'Share' })).toHaveCount(0);
    await viewer.getByRole('button', { name: 'History', exact: true }).click();
    const history = viewer.getByTestId('versions-panel');
    await expect(history.getByRole('button', { name: /checkpoint/ })).toBeVisible();
    await expect(history.getByRole('button', { name: 'Save version' })).toHaveCount(0);
    await expect(history.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);

    // API: direct writes are refused
    const patch = await viewer.request.patch(`/api/documents/${documentId}`, {
      data: { title: 'Hacked' },
      headers: { origin: ORIGIN },
    });
    expect([403, 404]).toContain(patch.status());
    const move = await viewer.request.post(`/api/documents/${documentId}/move`, {
      data: {},
      headers: { origin: ORIGIN },
    });
    expect([403, 404]).toContain(move.status());
    const restore = await viewer.request.post(
      `/api/documents/${documentId}/versions/${versionId}/restore`,
      { headers: { origin: ORIGIN } },
    );
    expect([403, 404]).toContain(restore.status());
    const publish = await viewer.request.post(`/api/documents/${documentId}/public-links`, {
      data: { mode: 'VIEW' },
      headers: { origin: ORIGIN },
    });
    expect([403, 404]).toContain(publish.status());
    const remove = await viewer.request.delete(`/api/documents/${documentId}`, {
      headers: { origin: ORIGIN },
    });
    expect([403, 404]).toContain(remove.status());

    // WebSocket: a raw client with a viewer ticket sends an update; the document does not change
    const raw = await connectRaw(context.request, documentId);
    await raw.synced;
    expect(raw.text()).toContain('Original text');
    const started = new Date(Date.now() - 5000);
    raw.injectParagraph('INJECTED BY VIEWER');
    // the server logs a refused update; once it has, there is nothing left in flight that could change the document
    await expect
      .poll(
        async () =>
          (await logsOf('collab', started)).lines.some(
            (line) =>
              line.event === 'collab.update_rejected' &&
              line.reason === 'read_only' &&
              line.documentId === documentId,
          ),
        { timeout: 20_000, intervals: [500] },
      )
      .toBe(true);
    raw.close();

    const check = await connectRaw(owner.request, documentId);
    await check.synced;
    expect(check.text()).toContain('Original text');
    expect(check.text()).not.toContain('INJECTED');
    check.close();
    // the owner's own page has been elsewhere (settings) since; a fresh load shows what was stored
    await openDocument(owner, workspaceId, documentId);
    await expect(editorOf(owner)).toContainText('Original text');
    await expect(editorOf(owner)).not.toContainText('INJECTED');
    await expect(owner.getByRole('textbox', { name: 'Document title' })).toHaveValue('Handbook');
    // none of the refused calls left a trace: the document is alive, unpublished and has its one version
    const state = await owner.request.get(`/api/documents/${documentId}/public-links`);
    expect(await state.json()).toEqual([]);
    const versions = await owner.request.get(`/api/documents/${documentId}/versions`);
    expect(((await versions.json()) as { label: string | null }[]).map((v) => v.label)).toContain(
      'checkpoint',
    );
  });
});

test.describe('concurrent editing', () => {
  test('simultaneous typing, in one block and in different blocks, loses nothing', async ({
    browser,
    baseURL,
    signedInPage: a,
  }) => {
    const workspaceId = await createWorkspace(a, 'Concurrent');
    const documentId = await createDocument(a, workspaceId, 'Shared');
    const { page: b, name: bName } = await invitedMember(
      browser,
      baseURL,
      a,
      workspaceId,
      'Editor',
    );
    await openEditable(a, workspaceId, documentId);
    await openEditable(b, workspaceId, documentId);

    // presence: each sees the other
    await expect(a.getByTestId('presence').getByRole('listitem', { name: bName })).toBeVisible();
    await expect(b.getByTestId('presence').getByRole('listitem')).toHaveCount(1);

    // The block already has text: two people typing their very first characters into an empty block at the same
    // moment can end up with one duplicated character (upstream y-prosemirror behaviour, see the README).
    await editorOf(a).click();
    await a.keyboard.type('seed ');
    await expect(editorOf(b)).toContainText('seed');
    await expect(saveStatus(a)).toHaveText('Saved');

    // the same paragraph, at the same time
    await editorOf(a).click();
    await editorOf(b).click();
    await Promise.all([
      a.keyboard.type('AAAAAAAA', { delay: 25 }),
      b.keyboard.type('BBBBBBBB', { delay: 25 }),
    ]);
    // different blocks: one appends a paragraph, the other writes at the start of the first one
    await a.keyboard.press('End');
    await a.keyboard.press('Enter');
    await b.keyboard.press('Home');
    await Promise.all([
      a.keyboard.type('second block from A', { delay: 15 }),
      b.keyboard.type('start-', { delay: 15 }),
    ]);

    const outcome = async () => {
      const [x, y] = await Promise.all([textOf(a), textOf(b)]);
      return {
        sameOnBoth: x === y,
        a: x,
        b: y,
        typedByA: (x.match(/A/g) ?? []).length,
        typedByB: (x.match(/B/g) ?? []).length,
        hasSecondBlock: x.includes('second block from A'),
        hasStart: x.includes('start-'),
      };
    };
    await expect.poll(outcome, { timeout: 15_000 }).toMatchObject({
      sameOnBoth: true,
      // 8 typed A + the A of "second block from A"
      typedByA: 9,
      typedByB: 8,
      hasSecondBlock: true,
      hasStart: true,
    });
    await expect(saveStatus(a)).toHaveText('Saved');
    await expect(saveStatus(b)).toHaveText('Saved');

    // what both see is what was stored
    const expected = await textOf(a);
    await a.reload();
    await expect.poll(() => textOf(a)).toBe(expected);
  });

  test('an editor that goes offline briefly keeps its edits and they merge on reconnect', async ({
    browser,
    baseURL,
    signedInPage: a,
  }) => {
    const workspaceId = await createWorkspace(a, 'Offline');
    const documentId = await createDocument(a, workspaceId, 'Flaky');
    const { page: b, context } = await invitedMember(browser, baseURL, a, workspaceId, 'Editor');
    const socket = await controllableSocket(b);
    await openEditable(a, workspaceId, documentId);
    await openEditable(b, workspaceId, documentId);
    await editorOf(a).click();
    await a.keyboard.type('base');
    await expect(editorOf(b)).toContainText('base');
    await expect(saveStatus(b)).toHaveText('Saved');

    await context.setOffline(true);
    await socket.cut();
    await expect(saveStatus(b)).toHaveText('Offline — changes will sync on reconnect');
    await editorOf(b).click();
    await b.keyboard.press('End');
    await b.keyboard.type(' +offline-B');
    await a.keyboard.press('End');
    await a.keyboard.type(' +online-A');
    await expect(editorOf(b)).not.toContainText('online-A');

    await context.setOffline(false);
    await expect(saveStatus(b)).toHaveText('Saved', { timeout: 20_000 });
    await expect(saveStatus(a)).toHaveText('Saved');
    for (const page of [a, b]) {
      await expect(editorOf(page)).toContainText('+offline-B');
      await expect(editorOf(page)).toContainText('+online-A');
    }
    expect(await textOf(a)).toBe(await textOf(b));
  });

  test('both editors offline at once edit the same block and different blocks, and every insertion survives', async ({
    browser,
    baseURL,
    signedInPage: a,
  }) => {
    const workspaceId = await createWorkspace(a, 'Both offline');
    const documentId = await createDocument(a, workspaceId, 'Split brain');
    const { page: b, context: contextB } = await invitedMember(
      browser,
      baseURL,
      a,
      workspaceId,
      'Editor',
    );
    const socketA = await controllableSocket(a);
    const socketB = await controllableSocket(b);
    await openEditable(a, workspaceId, documentId);
    await openEditable(b, workspaceId, documentId);
    await editorOf(a).click();
    await a.keyboard.type('base');
    await expect(editorOf(b)).toContainText('base');
    await expect(saveStatus(a)).toHaveText('Saved');
    await expect(saveStatus(b)).toHaveText('Saved');

    await Promise.all([a.context().setOffline(true), contextB.setOffline(true)]);
    await Promise.all([socketA.cut(), socketB.cut()]);
    const offline = 'Offline — changes will sync on reconnect';
    await expect(saveStatus(a)).toHaveText(offline);
    await expect(saveStatus(b)).toHaveText(offline);

    // A appends to the paragraph and adds a block; B writes in the middle of the same paragraph and adds a block
    await editorOf(a).click();
    await placeCaret(a, 0, 'end');
    await a.keyboard.type(' [A end]');
    await a.keyboard.press('Enter');
    await a.keyboard.type('block from A');
    await editorOf(b).click();
    await placeCaret(b, 0, 2);
    await b.keyboard.type('[B middle]');
    await placeCaret(b, 0, 'end');
    await b.keyboard.press('Enter');
    await b.keyboard.type('block from B');
    // nothing crossed while both were cut off
    await expect(editorOf(a)).not.toContainText('B middle');
    await expect(editorOf(b)).not.toContainText('A end');

    await Promise.all([a.context().setOffline(false), contextB.setOffline(false)]);
    await expect(saveStatus(a)).toHaveText('Saved', { timeout: 20_000 });
    await expect(saveStatus(b)).toHaveText('Saved', { timeout: 20_000 });
    const everything = ['[A end]', '[B middle]', 'block from A', 'block from B'];
    for (const page of [a, b]) {
      for (const piece of everything) await expect(editorOf(page)).toContainText(piece);
    }
    const [final, other] = await Promise.all([textOf(a), textOf(b)]);
    expect(final).toBe(other);
    // each insertion arrived whole, in the place it was made
    expect(final).toContain('ba[B middle]se [A end]');

    // and the merged document is what was stored
    await a.reload();
    await expect.poll(() => textOf(a)).toBe(final);
  });
});

test.describe('editor features', () => {
  test('a version can be saved, previewed and restored while the editor stays open', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'History');
    const documentId = await createDocument(page, workspaceId, 'Versioned');
    await openEditable(page, workspaceId, documentId);
    await editorOf(page).click();
    await page.keyboard.type('Version one');
    await expect(saveStatus(page)).toHaveText('Saved');

    await page.getByRole('button', { name: 'History', exact: true }).click();
    const panel = page.getByTestId('versions-panel');
    await panel.getByRole('textbox', { name: 'Version name' }).fill('first draft');
    await panel.getByRole('button', { name: 'Save version' }).click();
    await expect(panel.getByRole('button', { name: /first draft/ })).toBeVisible();
    await expect(panel.getByRole('region', { name: 'Version preview' })).toContainText(
      'Version one',
    );

    await editorOf(page).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' and more words');
    await expect(editorOf(page)).toContainText('and more words');
    await expect(saveStatus(page)).toHaveText('Saved');

    await panel.getByRole('button', { name: /first draft/ }).click();
    await panel.getByRole('button', { name: 'Restore this version' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
    await expect(editorOf(page)).toHaveText('Version one');
    await expect(panel.getByRole('button', { name: /Before restore/ })).toBeVisible();
  });

  test('blocks are inserted from the slash menu and the toolbar', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Blocks');
    const documentId = await createDocument(page, workspaceId, 'Blocks');
    await openEditable(page, workspaceId, documentId);
    await editorOf(page).click();

    await page.keyboard.type('/h2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Section');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/to-do');
    await page.keyboard.press('Enter');
    await page.keyboard.type('buy milk');
    await expect(editorOf(page).getByRole('heading', { level: 2, name: 'Section' })).toBeVisible();
    await expect(editorOf(page).getByRole('checkbox')).toHaveCount(1);

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.type('strong');
    await expect(editorOf(page).locator('strong')).toHaveText('strong');
    await expect(saveStatus(page)).toHaveText('Saved');

    await page.reload();
    await expect(editorOf(page).getByRole('heading', { level: 2, name: 'Section' })).toBeVisible();
    await expect(editorOf(page).locator('strong')).toHaveText('strong');
  });

  test('an uploaded image appears in the document and survives a reload', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Images');
    const documentId = await createDocument(page, workspaceId, 'Pictures');
    await openEditable(page, workspaceId, documentId);

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.getByLabel('Upload an image').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: png,
    });
    const image = page.getByTestId('image-block').locator('img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
    await expect(saveStatus(page)).toHaveText('Saved');

    await page.reload();
    await expect(page.getByTestId('image-block').locator('img')).toBeVisible();
  });

  test('a document that is deleted while it is open shows the deleted state', async ({
    browser,
    baseURL,
    signedInPage: owner,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Deleted');
    const documentId = await createDocument(owner, workspaceId, 'Doomed');
    const { page: editor } = await invitedMember(browser, baseURL, owner, workspaceId, 'Editor');
    await openEditable(editor, workspaceId, documentId);

    const response = await owner.request.delete(`/api/documents/${documentId}`, {
      headers: { origin: ORIGIN },
    });
    expect(response.status()).toBe(204);
    await expect(editor.getByRole('heading', { name: 'This document was deleted' })).toBeVisible();
    await expect(editorOf(editor)).toHaveCount(0);
  });
});
