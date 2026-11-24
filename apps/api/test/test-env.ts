import { loadRootDotenv } from '@jobfinder/config';

/**
 * Tests never touch the development database: they use `<db>_test` and Redis db 15,
 * derived from the same connection settings as the dev stack.
 */
export function resolveTestUrls(): {
  adminDatabaseUrl: string;
  databaseUrl: string;
  redisUrl: string;
  databaseName: string;
} {
  loadRootDotenv();
  const baseDb = process.env.DATABASE_URL;
  const baseRedis = process.env.REDIS_URL;
  if (!baseDb || !baseRedis) {
    throw new Error('DATABASE_URL and REDIS_URL must be set (see .env.example) to run API tests');
  }
  const db = new URL(baseDb);
  const databaseName = `${db.pathname.replace(/^\//, '') || 'jobfinder'}_test`.replace(
    /_test_test$/,
    '_test',
  );
  const testDb = new URL(baseDb);
  testDb.pathname = `/${databaseName}`;
  const redis = new URL(baseRedis);
  redis.pathname = '/15';
  return {
    adminDatabaseUrl: baseDb,
    databaseUrl: testDb.toString(),
    redisUrl: redis.toString(),
    databaseName,
  };
}
