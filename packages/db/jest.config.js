module.exports = {
  rootDir: 'src',
  testRegex: '.*\\.int\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': ['@swc/jest'] },
  // generated client imports TypeScript files with a .js extension
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
  testTimeout: 30000,
};
