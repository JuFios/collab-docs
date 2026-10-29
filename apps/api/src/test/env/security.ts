// Must be the first import of the security suites: AppModule parses the environment when it is imported.
// Redis database 2 (billing: 3, comments: 4, search: 5, publishing: 6, attachments: 7, versions: 8, collab: 10,
// documents: 11, workspaces: 12, auth: 13, queue: 14, platform: 15) because the suites run in parallel. The security
// suites share this database and never flush it: everything they create is new.
const redisUrl = new URL(process.env.REDIS_URL as string);
redisUrl.pathname = '/2';
process.env.REDIS_URL = redisUrl.toString();
process.env.ARGON2_MEMORY_KIB = '1024';
process.env.ARGON2_TIME_COST = '1';
// The matrix sends hundreds of requests from a handful of users; every request carries an address of its own,
// and the per-user limits are lifted so that they never decide a status. The limits are audited in rate-limits.
process.env.RATE_LOGIN_PER_MIN_IP = '10000';
process.env.RATE_LOGIN_PER_MIN_IP_EMAIL = '10000';
process.env.RATE_REGISTER_PER_HOUR_IP = '10000';
process.env.RATE_PUBLIC_LINK_PER_HOUR_USER = '10000';
process.env.RATE_TICKET_PER_MIN_USER = '10000';
process.env.RATE_GUEST_TICKET_PER_MIN_IP = '10000';
process.env.RATE_SEARCH_PER_MIN_USER = '10000';
process.env.RATE_COMMENT_PER_MIN_USER = '10000';
process.env.RATE_MOCK_PROVIDER_PER_MIN_IP = '10000';
process.env.RATE_INVITE_PER_HOUR_USER = '10000';
process.env.RATE_VERIFY_EMAIL_PER_HOUR_USER = '10000';
process.env.RATE_SHARE_PER_MIN_USER = '10000';
