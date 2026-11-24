import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Load the repo-root .env without overriding variables already set (CI / tests win).
const rootEnv = resolve(__dirname, '../../.env');
if (existsSync(rootEnv)) config({ path: rootEnv, override: false, quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
