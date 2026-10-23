const base = require('./jest.config');

// Integration tests need Postgres and Redis (docker compose up -d postgres redis).
module.exports = {
  ...base,
  testRegex: '.*\\.int\\.spec\\.ts$',
  testPathIgnorePatterns: [],
  testTimeout: 30000,
};
