// Informational coverage (`COVERAGE=1`): the CI summary reads `coverage/coverage-summary.json`.
const coverage = process.env.COVERAGE
  ? {
      collectCoverage: true,
      coverageProvider: 'v8',
      coverageDirectory: require('node:path').join(__dirname, 'coverage'),
      coverageReporters: ['text-summary', 'json-summary'],
      collectCoverageFrom: [
        '**/*.ts',
        '!**/*.spec.ts',
        '!**/test/**',
        '!**/testing/**',
        '!**/generated/**',
      ],
    }
  : {};
module.exports = {
  ...coverage,
  rootDir: 'src',
  testRegex: '.*\\.int\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': ['@swc/jest'] },
  // generated client imports TypeScript files with a .js extension
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
  testTimeout: 30000,
};
