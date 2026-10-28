import type { Page } from '@playwright/test';
import { expect, newUser, registerViaApi, test } from '../fixtures';
import { overflowOf, violationsOf } from '../axe';
import { inviteLinkFor } from '../mailpit';
import { ORIGIN, createDocument, createWorkspace, invitedMember, signedIn } from '../workspace';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 360, height: 812 },
] as const;

/**
 * An open menu or dialog hides the rest of the page from assistive technology on purpose, so rules that judge the
 * page as a whole (a heading, landmarks, focusable skip link under `aria-hidden`) cannot hold while one is open.
 */
const WHOLE_PAGE_RULES = ['aria-hidden-focus', 'page-has-heading-one', 'region'];

for (const viewport of VIEWPORTS) {
  test.describe(`accessibility of menus, dialogs and guest pages on a ${viewport.name}`, () => {
    test('no state has an accessibility violation or scrolls sideways', async ({
      signedInPage: page,
      browser,
      baseURL,
    }) => {
      test.setTimeout(300_000);
      const size = { width: viewport.width, height: viewport.height };
      await page.setViewportSize(size);
      const problems: string[] = [];
      const check = async (state: string, target: Page = page) => {
        await target.waitForLoadState('networkidle');
        const modal = (await target.locator('[role="dialog"], [role="menu"]').count()) > 0;
        for (const violation of await violationsOf(target)) {
          if (modal && WHOLE_PAGE_RULES.some((rule) => violation.startsWith(rule))) continue;
          problems.push(`${state}: ${violation}`);
        }
        const overflow = await overflowOf(target);
        if (overflow > 0) problems.push(`${state}: scrolls sideways by ${overflow}px`);
      };

      const workspaceId = await createWorkspace(page, 'Accessibility states');
      const documentId = await createDocument(page, workspaceId, 'Alpha plan');
      const child = await createDocument(page, workspaceId, 'Beta', documentId);
      await page.goto(`/workspaces/${workspaceId}/documents/${documentId}`);
      const editor = page.getByRole('textbox', { name: 'Document content' });
      await expect(editor).toHaveAttribute('contenteditable', 'true');
      await editor.click();
      await page.keyboard.type('Hello world with some words');

      // menus
      await page.getByRole('button', { name: 'Document actions' }).click();
      await check('document menu');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /switch workspace/ }).click();
      await check('workspace switcher');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /user menu/ }).click();
      await check('user menu');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^Notifications/ }).click();
      await check('notification menu');
      await page.keyboard.press('Escape');

      // dialogs and the editor's own popups
      await editor.click();
      await page.keyboard.press('ControlOrMeta+a');
      await page.getByRole('button', { name: 'Link', exact: true }).click();
      await check('link dialog');
      await page.keyboard.press('Escape');
      await expect(editor).toBeFocused();
      await editor.press('ControlOrMeta+End');
      await editor.press('Enter');
      await page.keyboard.type('/');
      await expect(page.getByRole('listbox')).toBeVisible();
      await check('slash menu');
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Share', exact: true }).click();
      await check('share dialog');
      await page.getByRole('button', { name: 'Publish to web' }).click();
      await expect(page.getByLabel('Public link')).toBeVisible();
      await page.getByRole('button', { name: 'Create edit link' }).click();
      const editLink = await page
        .getByRole('textbox', { name: 'Edit link', exact: true })
        .inputValue();
      await check('share dialog with a public page and an edit link');
      await page.keyboard.press('Escape');

      // a toast
      await page.goto(`/workspaces/${workspaceId}/settings`);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Workspace renamed.')).toBeVisible();
      await check('toast');

      // lists with content
      // the index follows an edit after a few seconds, so the search is repeated until it finds the title
      await expect(async () => {
        await page.goto(`/workspaces/${workspaceId}/search?q=Alpha`);
        await expect(
          page.getByRole('list', { name: 'Search results' }).getByRole('link'),
        ).toHaveCount(1, { timeout: 2_000 });
      }).toPass({ timeout: 30_000, intervals: [1_000] });
      await check('search results');
      const removed = await page.request.delete(`/api/documents/${child}`, {
        headers: { origin: ORIGIN },
      });
      expect(removed.ok()).toBe(true);
      await page.goto(`/workspaces/${workspaceId}/trash`);
      await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();
      await check('trash with a document');

      // members, a pending invitation and a reader
      const viewer = await invitedMember(browser, baseURL, page, workspaceId, 'Viewer');
      await viewer.page.setViewportSize(size);
      const invited = newUser('pending');
      await page.goto(`/workspaces/${workspaceId}/settings`);
      await page.getByRole('textbox', { name: 'Email' }).fill(invited.email);
      await page.getByRole('button', { name: 'Send invitation' }).click();
      await expect(page.getByRole('list', { name: 'Pending invitations' })).toContainText(
        invited.email,
      );
      await check('settings with members and a pending invitation');
      await viewer.page.goto(`/workspaces/${workspaceId}/documents/${documentId}`);
      await expect(viewer.page.getByRole('textbox', { name: 'Document content' })).toHaveAttribute(
        'contenteditable',
        'false',
      );
      await check('read-only document', viewer.page);

      // pages for people without a session or with another one
      const visitor = await (await browser.newContext({ baseURL, viewport: size })).newPage();
      await visitor.goto(new URL(editLink).pathname);
      await expect(visitor.getByRole('textbox', { name: 'Document content' })).toBeVisible();
      await check('edit link page', visitor);
      const invitePath = new URL(await inviteLinkFor(invited.email)).pathname;
      await visitor.goto(invitePath);
      await expect(visitor.getByRole('link', { name: 'Sign in' })).toBeVisible();
      await check('invitation (not signed in)', visitor);
      await registerViaApi((await browser.newContext({ baseURL })).request, invited);
      const guest = await signedIn(browser, baseURL, invited);
      await guest.page.setViewportSize(size);
      await guest.page.goto(invitePath);
      await expect(guest.page.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
      await check('invitation (signed in)', guest.page);
      await visitor.goto('/invite/not-a-real-token');
      await expect(visitor.getByRole('heading', { name: 'Invitation not valid' })).toBeVisible();
      await check('invitation (not valid)', visitor);

      // checkout
      await page.goto(`/workspaces/${workspaceId}/billing`);
      await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
      await expect(page).toHaveURL(/\/mock-checkout\//);
      await check('checkout');

      expect(problems, problems.join('\n')).toEqual([]);
    });
  });
}
