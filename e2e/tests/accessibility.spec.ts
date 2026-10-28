import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { ORIGIN, createDocument, createWorkspace } from '../workspace';

const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

interface Violation {
  id: string;
  impact?: string | null;
  nodes: { target: unknown[] }[];
}

/** Runs axe-core on the page as it is now and describes every violation, so a failure says what and where. */
async function violationsOf(page: Page): Promise<string[]> {
  await page.evaluate(AXE_SOURCE);
  const found = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<{ violations: Violation[] }> } })
      .axe;
    return (await axe.run()).violations;
  });
  return found.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const overflowOf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  // 360 is a common phone width and what 375 comes down to where scrollbars take room (Linux, CI)
  { name: 'phone', width: 360, height: 812 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`accessibility on a ${viewport.name}`, () => {
    test('no screen has an accessibility violation or scrolls sideways', async ({
      signedInPage: page,
      browser,
      baseURL,
    }) => {
      test.setTimeout(180_000);
      const size = { width: viewport.width, height: viewport.height };
      await page.setViewportSize(size);
      const visitor = await (await browser.newContext({ baseURL, viewport: size })).newPage();

      const problems: string[] = [];
      const check = async (screen: string, target: Page = page) => {
        await target.waitForLoadState('networkidle');
        for (const violation of await violationsOf(target))
          problems.push(`${screen}: ${violation}`);
        const overflow = await overflowOf(target);
        if (overflow > 0) problems.push(`${screen}: scrolls sideways by ${overflow}px`);
      };

      for (const path of ['/', '/login', '/register', '/this-page-does-not-exist']) {
        await visitor.goto(path);
        await check(`public ${path}`, visitor);
      }

      await page.goto('/workspaces');
      await check('workspaces (empty)');
      const workspaceId = await createWorkspace(page, 'Accessibility');
      const documentId = await createDocument(page, workspaceId, 'Quarterly plan');
      await createDocument(page, workspaceId, 'Child page', documentId);

      await page.goto(`/workspaces/${workspaceId}`);
      await check('dashboard');

      await page.goto(`/workspaces/${workspaceId}/documents/${documentId}`);
      const editor = page.getByRole('textbox', { name: 'Document content' });
      await expect(editor).toHaveAttribute('contenteditable', 'true');
      await editor.click();
      await page.keyboard.type('Some text in the document');
      await check('document');
      await page.getByRole('button', { name: 'History', exact: true }).click();
      await expect(page.getByTestId('versions-panel')).toBeVisible();
      await check('document with the history panel');

      for (const [screen, path] of [
        ['settings', 'settings'],
        ['billing', 'billing'],
        ['search', 'search?q=plan'],
        ['trash', 'trash'],
      ] as const) {
        await page.goto(`/workspaces/${workspaceId}/${path}`);
        await check(screen);
      }
      await page.goto('/notifications');
      await check('notifications');
      await page.goto('/shared');
      await check('shared with me');

      const link = await page.request.post(`/api/documents/${documentId}/public-links`, {
        data: { mode: 'VIEW' },
        headers: { origin: ORIGIN },
      });
      const { slug } = (await link.json()) as { slug: string };
      await expect
        .poll(async () => (await visitor.request.get(`/published/${slug}`)).status(), {
          timeout: 20_000,
        })
        .toBe(200);
      await visitor.goto(`/published/${slug}`);
      await check('published page', visitor);

      expect(problems, problems.join('\n')).toEqual([]);
    });
  });
}
