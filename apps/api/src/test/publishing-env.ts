// Must be the first import of the publishing suite: AppModule parses the environment when it is imported.
// Redis database 6 (attachments: 7, versions: 8, collab: 9, collab ticket: 10, documents: 11, workspaces: 12,
// auth: 13, queue: 14, platform: 15).
const redisUrl = new URL(process.env.REDIS_URL as string);
redisUrl.pathname = '/6';
process.env.REDIS_URL = redisUrl.toString();
process.env.ARGON2_MEMORY_KIB = '1024';
process.env.ARGON2_TIME_COST = '1';
// the debounce of the page revalidation, short enough for a test to wait for it
process.env.REVALIDATE_DEBOUNCE_MS = '500';
process.env.RATE_GUEST_TICKET_PER_MIN_IP = '5';
