// Must be the first import of the documents integration suite: AppModule parses the environment when it is imported.
// Redis database 11 (workspaces suite: 12, platform: 15, queue: 14, auth: 13) because the suites run in parallel.
const redisUrl = new URL(process.env.REDIS_URL as string);
redisUrl.pathname = '/11';
process.env.REDIS_URL = redisUrl.toString();
// fast hashing for tests; the production default is 19456 KiB
process.env.ARGON2_MEMORY_KIB = '1024';
process.env.ARGON2_TIME_COST = '1';
