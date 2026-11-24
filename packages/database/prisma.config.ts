import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Load the repo-root .env without overriding variables already set (CI / tests win).
const rootEnv = resolve(__dirname, '../../.env');
if (existsSync(rootEnv)) config({ path: rootEnv, override: false, quiet: true });

// `prisma generate` only reads the schema and never opens a connection, so it must work in
// CI/clean checkouts that have no database configured. Every command that does connect
// (migrate, studio, ...) still requires a real DATABASE_URL and fails with a clear message.
const generateOnly = process.argv.slice(2).includes('generate');
const url =
  generateOnly && !process.env.DATABASE_URL
    ? 'postgresql://placeholder:placeholder@localhost:5432/placeholder'
    : env('DATABASE_URL');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url },
});
