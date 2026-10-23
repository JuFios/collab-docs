import { type APIRequestContext, type Page, expect, test as base } from '@playwright/test';

export const PASSWORD = 'e2e-correct-horse-battery';

export interface TestUser {
  name: string;
  email: string;
  password: string;
}

let sequence = 0;

export function newUser(label = 'user'): TestUser {
  sequence += 1;
  const unique = `${Date.now()}-${process.pid}-${sequence}`;
  return { name: `E2E ${label}`, email: `e2e-${label}-${unique}@example.test`, password: PASSWORD };
}

/** Creates an account through the api, the way the app itself would; the context keeps the session cookies. */
export async function registerViaApi(
  request: APIRequestContext,
  user = newUser(),
): Promise<TestUser> {
  const response = await request.post('/api/auth/register', {
    data: user,
  });
  expect(response.status(), await response.text()).toBe(201);
  return user;
}

export async function loginThroughUi(page: Page, user: TestUser, from = '/login'): Promise<void> {
  await page.goto(from);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

interface Fixtures {
  /** A fresh account that exists in the database but is not signed in. */
  user: TestUser;
  /** A page whose browser context already holds that user's session (`storageState` from the api login). */
  signedInPage: Page;
}

export const test = base.extend<Fixtures>({
  user: async ({ request }, use) => {
    await use(await registerViaApi(request));
  },
  signedInPage: async ({ browser, user, baseURL }, use) => {
    const context = await browser.newContext({ baseURL });
    const login = await context.request.post('/api/auth/login', {
      data: { email: user.email, password: user.password },
    });
    expect(login.status(), await login.text()).toBe(200);
    await use(await context.newPage());
    await context.close();
  },
});

export { expect };
