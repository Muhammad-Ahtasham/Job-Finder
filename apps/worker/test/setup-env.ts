import { resolveTestUrls } from './test-env';

const urls = resolveTestUrls();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = urls.databaseUrl;
process.env.REDIS_URL = urls.redisUrl;
process.env.LOG_LEVEL = 'silent';
process.env.WORKER_HEARTBEAT_INTERVAL_MS = '1000';
// Fast, deterministic discovery tests.
process.env.DISCOVERY_RETRY_BASE_MS = '40';
process.env.DISCOVERY_MAX_ATTEMPTS = '3';
process.env.DISCOVERY_RECONCILE_STALE_SECONDS = '1';
