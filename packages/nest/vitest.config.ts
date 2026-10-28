import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // informational (`COVERAGE=1`): the CI summary reads `coverage/coverage-summary.json`
    coverage: {
      enabled: Boolean(process.env.COVERAGE),
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
