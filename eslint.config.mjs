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

const PACKAGES = ['shared', 'db', 'nest'];
const APPLICATIONS = ['api', 'collab', 'web'];

/** `forbid` holds names of workspace packages and applications; both import styles are covered. */
function boundaries(rules) {
  return rules.map(({ files, forbid, why }) => ({
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: forbid.flatMap((name) => {
            const isPackage = PACKAGES.includes(name);
            const dir = isPackage ? 'packages' : 'apps';
            return [
              ...(isPackage
                ? [{ group: [`@collab-docs/${name}`, `@collab-docs/${name}/*`], message: why }]
                : []),
              { group: [`**/${dir}/${name}`, `**/${dir}/${name}/**`], message: why },
            ];
          }),
        },
      ],
    },
  }));
}

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/src/generated/**',
      '**/.next/**',
      '**/coverage/**',
      // written by a failed e2e run, minified
      '**/playwright-report/**',
      '**/test-results/**',
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
    // a fixed sleep makes a test slow where the machine is fast and flaky where it is slow
    files: ['e2e/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'waitForTimeout',
          message: 'Wait for the thing that changes: expect(...), expect.poll(...) or a response.',
        },
      ],
    },
  },
  {
    // command-line scripts of the CI workflow: printing is their output
    files: ['.github/scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
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
    rules: { 'react/no-danger': 'error' },
  },
  {
    // a relative path may not leave the package it is written in, whatever the sibling directory is called
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.ts'],
    plugins: { import: importPlugin },
    settings: {
      'import/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx'] },
      'import/resolver': { typescript: { alwaysTryTypes: true } },
    },
    rules: { 'import/no-relative-packages': 'error' },
  },
  // Module boundaries. The workspace packages form one direction of dependency:
  //   shared <- nest <- api, collab        shared <- web        db <- api, collab
  // and the applications know nothing of one another. A package.json that lists a dependency is not enough, as
  // a relative path can reach any sibling directory.
  ...boundaries([
    {
      files: ['packages/shared/**/*.ts'],
      forbid: [...PACKAGES.filter((name) => name !== 'shared'), ...APPLICATIONS],
      why: 'shared is the leaf of the graph: it may not depend on any other package or application.',
    },
    {
      files: ['packages/db/**/*.ts'],
      forbid: [...PACKAGES.filter((name) => name !== 'db'), ...APPLICATIONS],
      why: 'db is a leaf: it may not depend on any other package or application.',
    },
    {
      files: ['packages/nest/**/*.ts'],
      forbid: ['db', ...APPLICATIONS],
      why: 'nest may use shared only; applications and the database layer sit above it.',
    },
    {
      files: ['apps/web/**/*.{ts,tsx}'],
      forbid: ['nest', 'db', 'api', 'collab'],
      why: 'The web app may use shared only; server-only packages and other applications stay out of the browser bundle.',
    },
    {
      files: ['apps/api/**/*.ts'],
      forbid: ['web', 'collab'],
      why: 'Applications talk over the network, not by importing each other.',
    },
    {
      files: ['apps/collab/**/*.ts'],
      forbid: ['web', 'api'],
      why: 'Applications talk over the network, not by importing each other.',
    },
    {
      files: ['e2e/**/*.ts'],
      forbid: [...PACKAGES.filter((name) => name !== 'shared'), ...APPLICATIONS],
      why: 'End-to-end tests drive the running stack; they do not import its code.',
    },
  ]),
);
