import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname) } },
  test: {
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules', '.next'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // informational (`COVERAGE=1`): the CI summary reads `coverage/coverage-summary.json`
    coverage: {
      enabled: Boolean(process.env.COVERAGE),
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}'],
    },
  },
});
