// Must be the first import of the billing suite: AppModule parses the environment when it is imported.
// Redis database 3 (comments: 4, search: 5, publishing: 6, attachments: 7, versions: 8, collab: 9,
// collab ticket: 10, documents: 11, workspaces: 12, auth: 13, queue: 14, platform: 15).
const redisUrl = new URL(process.env.REDIS_URL as string);
redisUrl.pathname = '/3';
process.env.REDIS_URL = redisUrl.toString();
process.env.ARGON2_MEMORY_KIB = '1024';
process.env.ARGON2_TIME_COST = '1';
// the suite pays, declines and re-sends from one address far more often than a person would
process.env.RATE_MOCK_PROVIDER_PER_MIN_IP = '10000';
