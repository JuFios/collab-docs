// Must be the first import of the rate-limit suite: AppModule parses the environment when it is imported.
// Redis database 1 (the other api suites use 2-15), flushed by this suite alone.
const redisUrl = new URL(process.env.REDIS_URL as string);
redisUrl.pathname = '/1';
process.env.REDIS_URL = redisUrl.toString();
process.env.ARGON2_MEMORY_KIB = '1024';
process.env.ARGON2_TIME_COST = '1';
// every limit is small enough to reach in a test; the window is the production one
process.env.RATE_GLOBAL_PER_MIN_IP = '30';
process.env.RATE_LOGIN_PER_MIN_IP = '3';
process.env.RATE_LOGIN_PER_MIN_IP_EMAIL = '3';
process.env.RATE_REGISTER_PER_HOUR_IP = '3';
process.env.RATE_PUBLIC_LINK_PER_HOUR_USER = '3';
process.env.RATE_TICKET_PER_MIN_USER = '3';
process.env.RATE_GUEST_TICKET_PER_MIN_IP = '3';
process.env.RATE_SEARCH_PER_MIN_USER = '3';
process.env.RATE_COMMENT_PER_MIN_USER = '3';
