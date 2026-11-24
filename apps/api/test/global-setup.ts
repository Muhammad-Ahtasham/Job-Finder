import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { resolveTestUrls } from './test-env';

/** Creates the `<db>_test` database if needed and applies all Prisma migrations to it. */
export default async function globalSetup(): Promise<void> {
  const { adminDatabaseUrl, databaseUrl, databaseName } = resolveTestUrls();

  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (exists.rowCount === 0) {
      // databaseName is derived from our own config, never user input; still quote it.
      await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
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
