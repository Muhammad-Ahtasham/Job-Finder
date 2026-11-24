# ADR 0001 — Monorepo layout, tooling and module boundaries

Status: accepted (Phase 1) · Supersedes parts of `docs/ARCHITECTURE_PLAN.md` §2 (see "Deviations")

## Decision

- pnpm workspaces + Turborepo. `apps/{api,worker,web}`, `packages/{config,contracts,database}`.
- API and worker are separate entry points (`NestFactory.create` vs `createApplicationContext`).
- Boundaries are enforced by ESLint `no-restricted-imports` (`eslint.config.mjs`):
  - `web` may not import `@jobfinder/database`, Nest, Prisma, argon2, ioredis or BullMQ (no business logic in the frontend).
  - `contracts` and `config` are leaf packages (no workspace/Nest deps).
  - Only `packages/database` may import `@prisma/*`.
  - Apps never import each other.
- Shared types/validation: zod schemas in `packages/contracts` are the single source for API DTOs, the frontend and queue/Redis keys.
- Packages compile to CommonJS `dist/` (consumed by Nest and Next alike); Turbo orders builds.

## Deviations from the approved plan (and why)

| Plan                                                                | Phase 1                    | Reason                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`                                                       | `packages/database`        | Name given in the Phase 1 brief.                                                                                                                                                                                            |
| `packages/domain`, `packages/modules`, `providers`, `safe-fetch`, … | not created yet            | Nothing to put in them until discovery exists; creating empty packages is speculative. Auth/workspaces/health live in `apps/api/src` and will be extracted to `packages/modules` when the worker needs them.                |
| NestJS "latest"                                                     | NestJS **11**              | Nest 12 is ESM-only; adopting it would force ESM across every package during a foundation phase. Revisit once the codebase is stable.                                                                                       |
| Prisma "latest"                                                     | Prisma **7.10.1** (stable) | `latest` on npm is an 8.0 release candidate. Prisma 7 requires a driver adapter (`@prisma/adapter-pg`) and `prisma.config.ts`; the generated client is emitted into `packages/database/src/generated` (git-ignored) as CJS. |
| `Session` model                                                     | added                      | Server-side sessions (ADR 0002) need a table; not listed in the brief's models but required by it.                                                                                                                          |
