import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { createDocument, createWorkspace } from '../workspace';

const FREE_DOCUMENT_LIMIT = 20;
/** The webhook goes through two queues with retries, so the plan follows the payment by a few seconds. */
const CONFIRMATION_TIMEOUT = 30_000;

interface Overview {
  plan: string;
  invoices: unknown[];
}

async function overview(page: Page, workspaceId: string): Promise<Overview> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/billing`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as Overview;
}

/** Fills a Free workspace with documents up to the plan limit, through the api. */
async function fillToLimit(page: Page, workspaceId: string): Promise<void> {
  for (let index = 0; index < FREE_DOCUMENT_LIMIT; index += 1) {
    await createDocument(page, workspaceId, `Document ${index + 1}`);
  }
}

async function openCheckout(page: Page, workspaceId: string, plan: 'Pro' | 'Team'): Promise<void> {
  await page.goto(`/w/${workspaceId}/billing`);
  await page.getByRole('button', { name: `Upgrade to ${plan}` }).click();
  await expect(page).toHaveURL(/\/mock-checkout\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: `Collab Docs ${plan}` })).toBeVisible();
}

test.describe('billing', () => {
  test('hitting the document limit explains it, and upgrading lifts it', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Limits');
    await fillToLimit(page, workspaceId);
    await page.goto(`/w/${workspaceId}`);

    await page.getByRole('button', { name: 'New document' }).click();
    const dialog = page.getByRole('dialog', { name: 'Limit reached' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Documents: 20 of 20 used on the Free plan.');
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}$`));

    await dialog.getByRole('link', { name: 'Upgrade plan' }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/billing$`));
    await expect(page.getByRole('progressbar', { name: 'Documents used' })).toHaveAttribute(
      'aria-valuenow',
      String(FREE_DOCUMENT_LIMIT),
    );

    await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
    await expect(page).toHaveURL(/\/mock-checkout\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: 'Pay $12.00' }).click();

    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/billing`));
    await expect(page.getByText(/Paid through/)).toBeVisible({ timeout: CONFIRMATION_TIMEOUT });
    await expect(page.getByRole('region', { name: 'Invoices' })).toContainText('$12.00');

    await page.goto(`/w/${workspaceId}`);
    await page.getByRole('button', { name: 'New document' }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/d/[0-9a-f-]{36}$`));
  });

  test('a webhook delivered twice changes the plan and the invoices once', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Idempotency');
    await openCheckout(page, workspaceId, 'Pro');
    await page.getByRole('button', { name: 'Pay and re-send webhook' }).click();

    await expect(page.getByText(/Paid through/)).toBeVisible({ timeout: CONFIRMATION_TIMEOUT });
    // the second delivery is queued behind the first; give it time to arrive before looking for its effect
    await page.waitForTimeout(3_000);
    const after = await overview(page, workspaceId);
    expect(after.plan).toBe('PRO');
    expect(after.invoices).toHaveLength(1);
  });

  test('a declined payment leaves the workspace on Free', async ({ signedInPage: page }) => {
    const workspaceId = await createWorkspace(page, 'Declined');
    await openCheckout(page, workspaceId, 'Team');
    await page.getByRole('button', { name: 'Fail payment' }).click();

    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/billing`));
    await expect(
      page.getByRole('alert').filter({ hasText: 'The payment was declined' }),
    ).toBeVisible();
    expect((await overview(page, workspaceId)).plan).toBe('FREE');
  });

  test('cancelling returns the workspace to Free', async ({ signedInPage: page }) => {
    const workspaceId = await createWorkspace(page, 'Cancel');
    await openCheckout(page, workspaceId, 'Pro');
    await page.getByRole('button', { name: 'Pay $12.00' }).click();
    await expect(page.getByText(/Paid through/)).toBeVisible({ timeout: CONFIRMATION_TIMEOUT });

    await page.getByRole('button', { name: 'Cancel subscription' }).click();
    await page
      .getByRole('dialog', { name: 'Cancel the subscription?' })
      .getByRole('button', { name: 'Cancel subscription' })
      .click();
    await expect(page.getByText('The subscription was canceled')).toBeVisible({
      timeout: CONFIRMATION_TIMEOUT,
    });
    expect((await overview(page, workspaceId)).plan).toBe('FREE');
  });
});
