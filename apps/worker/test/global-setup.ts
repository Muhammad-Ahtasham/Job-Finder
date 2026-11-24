import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { resolveTestUrls } from './test-env';

/** Ensures the `<db>_test` database exists and is migrated (idempotent; safe alongside the API suite). */
export default async function globalSetup(): Promise<void> {
  const { adminDatabaseUrl, databaseUrl, databaseName } = resolveTestUrls();
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (exists.rowCount === 0) {
      try {
        await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
      } catch (error) {
        // Another suite may have created it concurrently (42P04 = duplicate_database).
        if ((error as { code?: string }).code !== '42P04') throw error;
      }
    }
  } finally {
    await admin.end();
  }
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(__dirname, '../../../packages/database'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
    shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
  });
}
