import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

// The stack is started outside Playwright (`docker compose up --build --wait`), so the suite runs against
// the same images as production rather than dev servers.
export default defineConfig({
  testDir: 'e2e/tests',
  outputDir: 'test-results',
  // CI runners are small and the stack shares them with two browsers: 5 s (the default) is too tight for "Saved"
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // One retry at most. A test that needs it is listed by `.github/scripts/flaky-report.mjs` (from the JSON report)
  // in the job summary, so a flake gets a cause and a fix instead of disappearing behind the retry.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never' }],
        ['json', { outputFile: 'test-results/results.json' }],
      ]
    : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
