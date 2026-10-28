// jose is ESM-only: let @swc/jest transform it (and the pnpm-hoisted copy) to CommonJS.

// Informational coverage (`COVERAGE=1`): the CI summary reads `coverage/coverage-summary.json`.
const coverage = process.env.COVERAGE
  ? {
      collectCoverage: true,
      coverageProvider: 'v8',
      coverageDirectory: require('node:path').join(__dirname, 'coverage'),
      coverageReporters: ['text-summary', 'json-summary'],
      collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!**/test/**', '!**/testing/**'],
    }
  : {};
module.exports = {
  ...coverage,
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['\\.int\\.spec\\.ts$'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': ['@swc/jest'] },
  transformIgnorePatterns: ['/node_modules/(?!(\\.pnpm/)?jose)'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testEnvironment: 'node',
};
