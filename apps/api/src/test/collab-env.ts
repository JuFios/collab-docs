// Must be the first import of the collab ticket suite: AppModule parses the environment when it is imported.
// Redis database 10 (documents suite: 11, workspaces: 12, auth: 13, queue: 14, platform: 15).
const redisUrl = new URL(process.env.REDIS_URL as string);
redisUrl.pathname = '/10';
process.env.REDIS_URL = redisUrl.toString();
process.env.ARGON2_MEMORY_KIB = '1024';
process.env.ARGON2_TIME_COST = '1';
process.env.RATE_TICKET_PER_MIN_USER = '4';
