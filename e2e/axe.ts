import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

interface Violation {
  id: string;
  impact?: string | null;
  nodes: { target: unknown[] }[];
}

/** Runs axe-core on the page as it is now and describes every violation, so a failure says what and where. */
export async function violationsOf(page: Page): Promise<string[]> {
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

export const overflowOf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
