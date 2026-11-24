import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { resolveTestUrls } from './test-env';

/** Shared with apps/api/test/global-setup.ts: both suites prepare the same `<db>_test`. */
const SETUP_LOCK_KEY = 7_330_001;

/**
 * Ensures the `<db>_test` database exists and is migrated.
 *
 * The API and worker suites start in parallel (Turborepo) and share this database, so on a
 * fresh server they would race on CREATE DATABASE. A session-level advisory lock serializes
 * "ensure database + migrate" across processes.
 */
export default async function globalSetup(): Promise<void> {
  const { adminDatabaseUrl, databaseUrl, databaseName } = resolveTestUrls();

  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock($1::bigint)', [SETUP_LOCK_KEY]);

    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (exists.rowCount === 0) {
      try {
        await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
      } catch (error) {
        // Belt and braces if something outside this lock created it first:
        // 42P04 duplicate_database, 23505 unique_violation on pg_database.
        const code = (error as { code?: string }).code;
        if (code !== '42P04' && code !== '23505') throw error;
      }
    }

    execSync('pnpm exec prisma migrate deploy', {
      cwd: resolve(__dirname, '../../../packages/database'),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    });
  } finally {
    await admin
      .query('SELECT pg_advisory_unlock($1::bigint)', [SETUP_LOCK_KEY])
      .catch(() => undefined);
    await admin.end();
  }
}
