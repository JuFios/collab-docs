import type { Browser, BrowserContext, Page } from '@playwright/test';
import { inviteLinkFor } from './mailpit';
import { expect, newUser, registerViaApi } from './fixtures';

export const ORIGIN = 'http://localhost:3000';

/** A page whose context holds the session of `user` (logged in through the api, like the app itself would). */
export async function signedIn(
  browser: Browser,
  baseURL: string | undefined,
  user: { email: string; password: string },
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ baseURL });
  const login = await context.request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(login.status(), await login.text()).toBe(200);
  return { page: await context.newPage(), context };
}

export async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.goto('/w');
  await page.getByLabel('Workspace name').fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split('/')[2] as string;
}

export async function createDocument(
  page: Page,
  workspaceId: string,
  title: string,
  parentId?: string,
): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/documents`, {
    data: { title, parentId },
    headers: { origin: ORIGIN },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

export interface InvitedMember {
  page: Page;
  context: BrowserContext;
  name: string;
}

/** Registers a new user, invites them from `owner`'s settings page and accepts the invitation as them. */
export async function invitedMember(
  browser: Browser,
  baseURL: string | undefined,
  owner: Page,
  workspaceId: string,
  role: 'Editor' | 'Viewer',
): Promise<InvitedMember> {
  const member = await registerViaApi(
    (await browser.newContext({ baseURL })).request,
    newUser(role.toLowerCase()),
  );
  await owner.goto(`/w/${workspaceId}/settings`);
  await owner.getByRole('textbox', { name: 'Email' }).fill(member.email);
  await owner.getByRole('combobox', { name: 'Role' }).selectOption({ label: role });
  await owner.getByRole('button', { name: 'Send invitation' }).click();
  const { page, context } = await signedIn(browser, baseURL, member);
  await page.goto(new URL(await inviteLinkFor(member.email)).pathname);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}$`));
  return { page, context, name: member.name };
}
