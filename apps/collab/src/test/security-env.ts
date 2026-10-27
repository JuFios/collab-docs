// First import of the security suite. Redis database 1 keeps it away from the other collab suites (database 9),
// which run in parallel and flush theirs. Small limits make the abuse cases cheap to provoke.
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
redisUrl.pathname = '/1';
process.env.REDIS_URL = redisUrl.toString();
process.env.COLLAB_MAX_MESSAGES_PER_10S = '40';
process.env.COLLAB_MAX_DOCUMENT_BYTES = '20000';
process.env.COLLAB_MAX_AWARENESS_BYTES = '512';
