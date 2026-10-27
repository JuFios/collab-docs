import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import importPlugin from 'eslint-plugin-import';
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
    ignores: [
      '**/dist/**',
      '**/src/generated/**',
      '**/.next/**',
      '**/coverage/**',
      '**/next-env.d.ts',
    ],
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
    // a cycle between source files breaks Nest's module and provider resolution at start-up
    files: ['apps/api/**/*.ts', 'apps/collab/**/*.ts', 'packages/**/*.ts'],
    plugins: { import: importPlugin },
    settings: {
      'import/parsers': { '@typescript-eslint/parser': ['.ts'] },
      'import/resolver': { typescript: { alwaysTryTypes: true } },
    },
    rules: { 'import/no-cycle': 'error' },
  },
  {
    // constructor types are the DI tokens: a class used in a decorated signature must stay a value import,
    // and the rule knows that when the parser is told the compiler options
    files: ['apps/api/**/*.ts', 'apps/collab/**/*.ts', 'packages/nest/**/*.ts'],
    languageOptions: {
      parserOptions: { emitDecoratorMetadata: true, experimentalDecorators: true },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  {
    files: ['**/*.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // SQL goes to the database as bound parameters (tagged templates, Prisma.sql); markup is never built by hand
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.ts'],
    // generated code, and test fixtures (a test may TRUNCATE tables by name or build a DOM from a string)
    ignores: ['**/generated/**', '**/*.{test,spec}.{ts,tsx}', 'packages/db/src/testing/**'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/^\\$(query|execute)RawUnsafe$/]',
          message: 'Unsafe raw queries splice text into SQL. Use a tagged $queryRaw / Prisma.sql.',
        },
        {
          selector: "MemberExpression[object.name='Prisma'][property.name='raw']",
          message:
            'Prisma.raw splices text into SQL. Pass the value as a ${parameter} of Prisma.sql.',
        },
        {
          selector:
            'CallExpression[callee.property.name=/^\\$(query|execute)Raw$/][arguments.0.type=/^(Literal|TemplateLiteral|BinaryExpression)$/]',
          message: 'Call $queryRaw / $executeRaw as a tagged template, so that values are bound.',
        },
        {
          selector: 'AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]',
          message: 'Assigning HTML is an XSS sink. Render with the framework, or sanitise first.',
        },
        {
          selector:
            'CallExpression[callee.property.name=/^(insertAdjacentHTML|write|writeln)$/][callee.object.name=/^(document|[a-z]+Element)$/]',
          message: 'Writing HTML is an XSS sink. Render with the framework, or sanitise first.',
        },
      ],
    },
  },
  ...webConfigs,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'react/no-danger': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@collab-docs/nest', '@collab-docs/db', '@collab-docs/db/*'],
              message: 'Server-only packages must not be imported into the web app.',
            },
          ],
        },
      ],
    },
  },
);
