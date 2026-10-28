import { expect, test } from '../fixtures';
import { createDocument, createWorkspace } from '../workspace';

/** A name or title without a space (an address pasted in, say) cannot wrap, and used to stretch whole pages. */
const LONG_NAME = 'W'.repeat(80);
const LONG_TITLE = 'T'.repeat(200);

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 360, height: 812 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`very long names do not make a page scroll sideways on a ${viewport.name}`, async ({
    signedInPage: page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const workspaceId = await createWorkspace(page, LONG_NAME);
    const parent = await createDocument(page, workspaceId, LONG_TITLE);
    const child = await createDocument(page, workspaceId, LONG_TITLE, parent);

    const base = `/workspaces/${workspaceId}`;
    for (const path of [
      '/workspaces?all=1',
      base,
      `${base}/documents/${child}`,
      `${base}/search?q=${'T'.repeat(20)}`,
      `${base}/settings`,
      `${base}/billing`,
      `${base}/trash`,
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
    }
  });
}
