import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { logsOf } from '../logs';
import { ORIGIN, createDocument, createWorkspace } from '../workspace';

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
    // the confirmation and the two repeats each wait on the queues
    test.setTimeout(90_000);
    const workspaceId = await createWorkspace(page, 'Idempotency');
    await openCheckout(page, workspaceId, 'Pro');
    const sessionId = new URL(page.url()).pathname.split('/').pop();

    // the payment, then the provider delivers the same event again and again; the ids come from the api so that
    // the test waits for exactly those deliveries instead of for a guessed amount of time
    const paid = await page.request.post(
      `/api/mock-provider/checkout-sessions/${sessionId}/complete`,
      {
        headers: { origin: ORIGIN },
      },
    );
    expect(paid.status(), await paid.text()).toBe(202);
    const { eventId } = (await paid.json()) as { eventId: string };
    await expect
      .poll(async () => (await overview(page, workspaceId)).plan, {
        timeout: CONFIRMATION_TIMEOUT,
        intervals: [500, 1000],
      })
      .toBe('PRO');

    const started = new Date(Date.now() - 60_000);
    for (const repeat of [1, 2]) {
      const again = await page.request.post(`/api/mock-provider/events/${eventId}/redeliver`, {
        headers: { origin: ORIGIN },
      });
      expect(again.status(), `redelivery ${repeat}`).toBe(202);
    }
    await expect
      .poll(
        async () =>
          (await logsOf('api', started)).lines.filter(
            (line) => line.event === 'webhook.duplicate_delivery' && line.eventId === eventId,
          ).length,
        { timeout: CONFIRMATION_TIMEOUT, intervals: [500, 1000] },
      )
      .toBe(2);

    const after = await overview(page, workspaceId);
    expect(after.plan).toBe('PRO');
    expect(after.invoices).toHaveLength(1);
  });

  test('the checkout button that re-sends the webhook leaves one plan change and one invoice', async ({
    signedInPage: page,
  }) => {
    const workspaceId = await createWorkspace(page, 'Resend button');
    await openCheckout(page, workspaceId, 'Pro');
    await page.getByRole('button', { name: 'Pay and re-send webhook' }).click();

    await expect(page.getByText(/Paid through/)).toBeVisible({ timeout: CONFIRMATION_TIMEOUT });
    await expect(page.getByRole('region', { name: 'Invoices' })).toContainText('$12.00');
    // that the repeat was really delivered is shown by the test above, which waits for it in the logs; this
    // one covers the button of the mock checkout
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
