// Must be the first import of the auth integration suite: AppModule parses the environment when it is imported.
// Redis database 13 (platform suite: 15, queue suite: 14) because the suites run in parallel.
const redisUrl = new URL(process.env.REDIS_URL as string);
redisUrl.pathname = '/13';
process.env.REDIS_URL = redisUrl.toString();
process.env.RATE_LOGIN_PER_MIN_IP = '8';
// fast hashing for tests; the production default is 19456 KiB
process.env.ARGON2_MEMORY_KIB = '1024';
process.env.ARGON2_TIME_COST = '1';
