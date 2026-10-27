import type { Browser, Page } from '@playwright/test';
import { inviteLinkFor } from '../mailpit';
import { expect, newUser, registerViaApi, test } from '../fixtures';

/** A page for a user that exists already, signed in through the api (no UI login). */
async function signedIn(
  browser: Browser,
  baseURL: string | undefined,
  user: { email: string; password: string },
): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  const login = await context.request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(login.status(), await login.text()).toBe(200);
  return context.newPage();
}

async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.goto('/w');
  await page.getByLabel('Workspace name').fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split('/')[2]!;
}

async function invite(page: Page, workspaceId: string, email: string, role = 'Editor') {
  await page.goto(`/w/${workspaceId}/settings`);
  // role queries skip the hidden copy that streaming leaves in the DOM until the boundary is revealed
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('combobox', { name: 'Role' }).selectOption({ label: role });
  await page.getByRole('button', { name: 'Send invitation' }).click();
}

test.describe('workspaces', () => {
  test('a new user sees the empty state, creates a workspace and lands on its dashboard', async ({
    signedInPage: page,
  }) => {
    await page.goto('/w');
    await expect(page.getByText('No workspaces yet')).toBeVisible();

    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByText('Enter a workspace name.')).toBeVisible();

    await page.getByLabel('Workspace name').fill('Acme Docs');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Acme Docs', level: 1 })).toBeVisible();
    // every block settles on its own
    await expect(page.getByRole('heading', { name: 'Recent documents' })).toBeVisible();
    await expect(page.getByText('No documents yet')).toBeVisible();
    await expect(page.getByText('1 of 3')).toBeVisible();
    await expect(
      page.getByText('Nothing has been shared with you in this workspace.'),
    ).toBeVisible();
  });

  test('/w returns to the last opened workspace unless the full list is requested', async ({
    signedInPage: page,
  }) => {
    const first = await createWorkspace(page, 'First');
    await page.goto('/w');
    await expect(page).toHaveURL(new RegExp(`/w/${first}$`));

    await page.goto('/w?all=1');
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /First/ })).toBeVisible();
  });

  test('the switcher moves between workspaces', async ({ signedInPage: page }) => {
    await createWorkspace(page, 'Alpha');
    await page.goto('/w?all=1');
    await page.getByLabel('Workspace name').fill('Beta');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Beta', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page.getByRole('menuitem', { name: 'Alpha' }).click();
    await expect(page.getByRole('heading', { name: 'Alpha', level: 1 })).toBeVisible();
  });

  test('invite -> pending -> mail -> accept by the second user', async ({
    browser,
    baseURL,
    signedInPage: owner,
  }) => {
    const guest = await registerViaApi(
      (await browser.newContext({ baseURL })).request,
      newUser('guest'),
    );
    const workspaceId = await createWorkspace(owner, 'Team Space');

    await invite(owner, workspaceId, guest.email);
    await expect(owner.getByRole('list', { name: 'Pending invitations' })).toContainText(
      guest.email,
    );

    const link = await inviteLinkFor(guest.email);
    const second = await signedIn(browser, baseURL, guest);
    await second.goto(new URL(link).pathname);
    await expect(second.getByRole('heading', { name: 'Join Team Space' })).toBeVisible();
    await second.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(second).toHaveURL(new RegExp(`/w/${workspaceId}$`));
    await expect(second.getByRole('heading', { name: 'Team Space', level: 1 })).toBeVisible();
    // an editor does not get the admin tab
    await expect(second.getByRole('link', { name: 'Settings' })).toHaveCount(0);

    await owner.reload();
    await expect(owner.getByRole('list', { name: 'Pending invitations' })).toHaveCount(0);
    await expect(owner.getByRole('table', { name: 'Workspace members' })).toContainText(
      guest.email,
    );
  });

  test('an invite link first asks anonymous visitors to sign in, and brings them back', async ({
    browser,
    baseURL,
    signedInPage: owner,
    page,
  }) => {
    const guest = await registerViaApi(
      (await browser.newContext({ baseURL })).request,
      newUser('late'),
    );
    const workspaceId = await createWorkspace(owner, 'Returning');
    await invite(owner, workspaceId, guest.email, 'Viewer');
    const path = new URL(await inviteLinkFor(guest.email)).pathname;

    await page.goto(path);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Finvite%2F/);
    await page.getByLabel('Email').fill(guest.email);
    await page.getByLabel('Password').fill(guest.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}$`));
  });

  test('an invitation for another account cannot be accepted', async ({
    browser,
    baseURL,
    signedInPage: owner,
  }) => {
    const other = await registerViaApi(
      (await browser.newContext({ baseURL })).request,
      newUser('other'),
    );
    const target = newUser('target');
    const workspaceId = await createWorkspace(owner, 'Private');
    await invite(owner, workspaceId, target.email);
    const path = new URL(await inviteLinkFor(target.email)).pathname;

    const page = await signedIn(browser, baseURL, other);
    await page.goto(path);
    await expect(page.getByRole('alert').filter({ hasText: target.email })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  });

  test('a revoked or unknown invitation says so', async ({ page }) => {
    await page.goto('/invite/this-token-does-not-exist');
    await expect(page.getByRole('heading', { name: 'Invitation not valid' })).toBeVisible();
  });

  test('revoking a pending invitation removes it from the list', async ({
    signedInPage: owner,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Revocations');
    await invite(owner, workspaceId, 'nobody@example.test');
    const list = owner.getByRole('list', { name: 'Pending invitations' });
    await expect(list).toContainText('nobody@example.test');
    await owner.getByRole('button', { name: 'Revoke invitation for nobody@example.test' }).click();
    await expect(list).toHaveCount(0);
    await expect(owner.getByText('No pending invitations').first()).toBeVisible();
  });

  test('renaming the workspace updates the header', async ({ signedInPage: owner }) => {
    const workspaceId = await createWorkspace(owner, 'Old name');
    await owner.goto(`/w/${workspaceId}/settings`);
    const input = owner.getByRole('textbox', { name: 'Workspace name' });
    await input.fill('New name');
    await owner.getByRole('button', { name: 'Save' }).click();
    await expect(owner.getByRole('heading', { name: 'New name', level: 1 })).toBeVisible();
  });

  test('the Free plan limit is explained, counting pending invitations', async ({
    signedInPage: owner,
  }) => {
    const workspaceId = await createWorkspace(owner, 'Crowded');
    // the owner plus two pending invitations fill the three Free slots
    await invite(owner, workspaceId, 'one@example.test');
    await expect(owner.getByRole('list', { name: 'Pending invitations' })).toContainText(
      'one@example.test',
    );
    await invite(owner, workspaceId, 'two@example.test');
    await expect(owner.getByRole('list', { name: 'Pending invitations' })).toContainText(
      'two@example.test',
    );

    await invite(owner, workspaceId, 'three@example.test');
    // the limit also opens the dialog every plan limit ends in; an admin is offered the plans
    const dialog = owner.getByRole('dialog', { name: 'Limit reached' });
    await expect(dialog).toContainText('Members: 3 of 3 used on the Free plan.');
    await expect(dialog.getByRole('link', { name: 'Upgrade plan' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toBeHidden();

    const alert = owner.locator('form [role="alert"]');
    await expect(alert).toContainText('The Free plan allows 3 members');
    await expect(alert).toContainText('pending invitations count too');
    // what was typed stays in the form
    await expect(owner.getByRole('textbox', { name: 'Email' })).toHaveValue('three@example.test');
  });

  test('members without admin rights cannot open settings, and strangers get a not-found page', async ({
    browser,
    baseURL,
    signedInPage: owner,
  }) => {
    const stranger = await registerViaApi(
      (await browser.newContext({ baseURL })).request,
      newUser('stranger'),
    );
    const viewer = await registerViaApi(
      (await browser.newContext({ baseURL })).request,
      newUser('viewer'),
    );
    const workspaceId = await createWorkspace(owner, 'Locked');
    await invite(owner, workspaceId, viewer.email, 'Viewer');
    const viewerPage = await signedIn(browser, baseURL, viewer);
    await viewerPage.goto(new URL(await inviteLinkFor(viewer.email)).pathname);
    await viewerPage.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(viewerPage).toHaveURL(new RegExp(`/w/${workspaceId}$`));

    await viewerPage.goto(`/w/${workspaceId}/settings`);
    await expect(viewerPage.getByRole('heading', { name: 'Access denied' })).toBeVisible();

    const outsider = await signedIn(browser, baseURL, stranger);
    await outsider.goto(`/w/${workspaceId}`);
    await expect(outsider.getByText('Page not found')).toBeVisible();
    await outsider.goto('/w/not-a-uuid');
    await expect(outsider.getByText('Page not found')).toBeVisible();
  });

  test('a member can leave a workspace, the last owner cannot', async ({
    browser,
    baseURL,
    signedInPage: owner,
  }) => {
    const guest = await registerViaApi(
      (await browser.newContext({ baseURL })).request,
      newUser('leaver'),
    );
    const workspaceId = await createWorkspace(owner, 'Revolving door');

    // the only owner is refused, with the reason
    await owner.getByRole('button', { name: 'Leave workspace' }).click();
    await owner.getByRole('dialog').getByRole('button', { name: 'Leave workspace' }).click();
    await expect(owner.getByRole('dialog').getByRole('alert')).toContainText('at least one owner');
    await owner.getByRole('button', { name: 'Cancel' }).click();

    await invite(owner, workspaceId, guest.email);
    const member = await signedIn(browser, baseURL, guest);
    await member.goto(new URL(await inviteLinkFor(guest.email)).pathname);
    await member.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(member).toHaveURL(new RegExp(`/w/${workspaceId}$`));

    await member.getByRole('button', { name: 'Leave workspace' }).click();
    await member.getByRole('dialog').getByRole('button', { name: 'Leave workspace' }).click();
    await expect(member).toHaveURL(/\/w\?all=1$/);
    await expect(member.getByText('No workspaces yet')).toBeVisible();
    await member.goto(`/w/${workspaceId}`);
    await expect(member.getByText('Page not found')).toBeVisible();

    await owner.goto(`/w/${workspaceId}/settings`);
    await expect(owner.getByRole('table', { name: 'Workspace members' })).not.toContainText(
      guest.email,
    );
  });
});
