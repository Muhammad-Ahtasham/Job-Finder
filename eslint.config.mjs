import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// NOTE: flat-config rules from later matching blocks REPLACE earlier ones, so each file
// area gets exactly one block that lists every pattern it forbids.
const restrict = (groups) => ({
  'no-restricted-imports': [
    'error',
    { patterns: groups.map(([group, message]) => ({ group, message })) },
  ],
});
const PRISMA = [['@prisma/*'], 'Prisma is an implementation detail of @jobfinder/database.'];

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/.next/**',
    '**/node_modules/**',
    '**/coverage/**',
    'packages/database/src/generated/**',
    'packages/database/prisma/migrations/**',
    'apps/web/next-env.d.ts',
    'apps/web/src/components/ui/**',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // NOTE: do not enable consistent-type-imports — NestJS DI needs runtime imports
      // of constructor parameter types for decorator metadata.
    },
  },

  // ---- Architectural boundaries (see docs/adr/0001-monorepo-and-boundaries.md) ----
  {
    // The frontend contains no business logic and no server-side dependencies.
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: restrict([
      PRISMA,
      [
        [
          '@jobfinder/database',
          '@jobfinder/discovery',
          '@jobfinder/api',
          '@jobfinder/worker',
          '@nestjs/*',
          'argon2',
          'ioredis',
          'bullmq',
        ],
        'The web app may only depend on @jobfinder/contracts (and config); business logic lives in the API.',
      ],
    ]),
  },
  {
    // contracts + config are leaf packages.
    files: ['packages/contracts/**/*.ts', 'packages/config/**/*.ts', 'packages/discovery/**/*.ts'],
    rules: restrict([
      PRISMA,
      [
        ['@jobfinder/*', '@nestjs/*'],
        'Leaf packages must not depend on other workspace packages or Nest.',
      ],
    ]),
  },
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts'],
    rules: restrict([
      PRISMA,
      [
        ['@jobfinder/api', '@jobfinder/worker', '@jobfinder/web'],
        'Apps must not import other apps.',
      ],
    ]),
  },

  // Vitest globals-free config & test files may use dev-only patterns.
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
]);
