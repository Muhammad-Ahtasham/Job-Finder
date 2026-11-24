import { loadRootDotenv } from '@jobfinder/config';

/**
 * Worker tests use `<db>_test` (shared with the API tests) and Redis db 14 so they never
 * touch dev data or collide with the API test suite's Redis db 15.
 */
export function resolveTestUrls() {
  loadRootDotenv();
  const baseDb = process.env.DATABASE_URL;
  const baseRedis = process.env.REDIS_URL;
  if (!baseDb || !baseRedis) {
    throw new Error(
      'DATABASE_URL and REDIS_URL must be set (see .env.example) to run worker tests',
    );
  }
  const databaseName = `${new URL(baseDb).pathname.replace(/^\//, '') || 'jobfinder'}_test`;
  const testDb = new URL(baseDb);
  testDb.pathname = `/${databaseName}`;
  const redis = new URL(baseRedis);
  redis.pathname = '/14';
  return {
    adminDatabaseUrl: baseDb,
    databaseUrl: testDb.toString(),
    redisUrl: redis.toString(),
    databaseName,
  };
}
