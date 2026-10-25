// jose is ESM-only: let @swc/jest transform it (and the pnpm-hoisted copy) to CommonJS.
module.exports = {
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['\\.int\\.spec\\.ts$'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': ['@swc/jest'] },
  transformIgnorePatterns: ['/node_modules/(?!(\\.pnpm/)?jose)'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testEnvironment: 'node',
};
