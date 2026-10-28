// Must be the first import of the search suite: AppModule parses the environment when it is imported.
// Redis database 5 (publishing: 6, attachments: 7, versions: 8, collab: 9, collab ticket: 10, documents: 11,
// workspaces: 12, auth: 13, queue: 14, platform: 15).
const redisUrl = new URL(process.env.REDIS_URL as string);
redisUrl.pathname = '/5';
process.env.REDIS_URL = redisUrl.toString();
process.env.ARGON2_MEMORY_KIB = '1024';
process.env.ARGON2_TIME_COST = '1';
// the debounce of the index updates, short enough for a test to wait for it
process.env.SEARCH_DEBOUNCE_MS = '300';
process.env.RATE_SEARCH_PER_MIN_USER = '40';
