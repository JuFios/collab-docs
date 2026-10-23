import { expect, loginThroughUi, newUser, test } from '../fixtures';

test.describe('authentication', () => {
  test('an anonymous visit to /w redirects to the login page and remembers the target', async ({
    page,
  }) => {
    await page.goto('/w');
    await expect(page).toHaveURL(/\/login\?next=%2Fw$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('signing in lands on the workspaces page and returns to the requested path', async ({
    page,
    user,
  }) => {
    await loginThroughUi(page, user, '/login?next=/w');
    await expect(page).toHaveURL(/\/w$/);
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
  });

  test('wrong credentials keep the user on the form with a message', async ({ page, user }) => {
    await loginThroughUi(page, { ...user, password: 'definitely-not-the-password' });
    await expect(page.locator('form [role="alert"]')).toContainText('Invalid email or password');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a new account can be registered through the UI', async ({ page }) => {
    const user = newUser('signup');
    await page.goto('/register');
    await page.getByLabel('Name').fill(user.name);
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/w$/);
  });

  test('unsafe next values are ignored after signing in', async ({ page, user }) => {
    await loginThroughUi(page, user, `/login?next=${encodeURIComponent('https://evil.example')}`);
    await expect(page).toHaveURL(/\/w$/);
  });

  test('signed-in users are bounced away from /login', async ({ signedInPage }) => {
    await signedInPage.goto('/login');
    await expect(signedInPage).toHaveURL(/\/w$/);
  });

  test('logging out ends the session', async ({ signedInPage }) => {
    await signedInPage.goto('/w');
    await signedInPage.getByRole('button', { name: 'User menu' }).click();
    await signedInPage.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(signedInPage).toHaveURL(/\/login$/);
    await signedInPage.goto('/w');
    await expect(signedInPage).toHaveURL(/\/login\?next=%2Fw$/);
  });

  test('an expired access token is renewed transparently', async ({ signedInPage }) => {
    const context = signedInPage.context();
    // drop only the access cookie: the middleware must route through the api refresh endpoint
    const cookies = await context.cookies();
    await context.clearCookies({ name: 'cd_at' });
    expect(cookies.some((c) => c.name === 'cd_rt')).toBe(true);
    await signedInPage.goto('/w');
    await expect(signedInPage).toHaveURL(/\/w$/);
    await expect(
      signedInPage.getByRole('heading', { name: 'Workspaces', exact: true }),
    ).toBeVisible();
  });
});
