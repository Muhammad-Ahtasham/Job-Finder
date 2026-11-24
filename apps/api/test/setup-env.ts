import { resolveTestUrls } from './test-env';

const urls = resolveTestUrls();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = urls.databaseUrl;
process.env.REDIS_URL = urls.redisUrl;
process.env.LOG_LEVEL = 'silent';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.SESSION_COOKIE_NAME = 'jf_session';
process.env.SESSION_COOKIE_SECURE = 'false';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '1000';
