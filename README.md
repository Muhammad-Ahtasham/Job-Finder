# Company Discovery & Job Intelligence Platform

Phase 1 foundation: monorepo, auth, workspaces, health, queues. Company discovery is **not** implemented yet. Architecture: [`docs/ARCHITECTURE_PLAN.md`](docs/ARCHITECTURE_PLAN.md) · decisions: [`docs/adr`](docs/adr).

## Prerequisites

Node ≥ 22, pnpm 12 (`npm i -g pnpm` or Corepack), Docker.

## Run locally

```bash
cp .env.example .env          # review values; dev passwords only
pnpm install
pnpm infra:up                 # PostgreSQL (pgvector) + Redis via Docker Compose
pnpm db:deploy                # apply migrations (use `pnpm db:migrate` when changing the schema)
pnpm dev                      # api :4000, worker, web :3000
```

- Web: http://localhost:3000 · Swagger: http://localhost:4000/docs
- Health: `GET :4000/health/live`, `GET :4000/health/ready` (database, redis, worker)

## Scripts

`pnpm build | lint | typecheck | test | format` (Turborepo). Tests need the Docker services running; they use a separate `<db>_test` database and Redis db 14/15.

## Layout

`apps/api` (NestJS REST) · `apps/worker` (BullMQ consumers) · `apps/web` (Next.js) · `packages/contracts` (zod schemas, shared types) · `packages/database` (Prisma schema, migrations, client) · `packages/config` (validated env).
