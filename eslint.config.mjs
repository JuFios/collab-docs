import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const compat = new FlatCompat({ baseDirectory: path.dirname(fileURLToPath(import.meta.url)) });

const webConfigs = compat
  .config({
    extends: ['next/core-web-vitals', 'next/typescript'],
    settings: { next: { rootDir: 'apps/web' } },
  })
  .map((config) => ({ ...config, files: ['apps/web/**/*.{ts,tsx,js,mjs}'] }));

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
    },
  },
  {
    files: [
      'apps/api/**/*.ts',
      'apps/collab/**/*.ts',
      'packages/**/*.ts',
      '**/*.config.{js,mjs,ts}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  {
    files: ['**/*.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  ...webConfigs,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@collab-docs/shared/nest', '@collab-docs/db', '@collab-docs/db/*'],
              message: 'Server-only packages must not be imported into the web app.',
            },
          ],
        },
      ],
    },
  },
);
