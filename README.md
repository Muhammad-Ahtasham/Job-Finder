# Company Discovery & Job Intelligence Platform

Phases 1–4: monorepo, auth, workspaces, search projects, company discovery, company website enrichment and
**career page discovery with job provider integrations** (Greenhouse, Lever, Ashby + generic career pages). Architecture: [`docs/ARCHITECTURE_PLAN.md`](docs/ARCHITECTURE_PLAN.md) · decisions: [`docs/adr`](docs/adr).

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

- Web: http://localhost:3000 (projects → start a run → live progress → results; reviews for ambiguous matches)
- Swagger: http://localhost:4000/docs · Health: `GET :4000/health/live`, `GET :4000/health/ready`

## Discovery providers

Set `DISCOVERY_PROVIDERS` (worker). Default `overpass-osm` needs no key but uses the shared public Overpass
instance — fine for light use, often saturated; point `OVERPASS_API_URL` at your own instance for real work.
`brave-search` needs `BRAVE_SEARCH_API_KEY` **and** `BRAVE_SEARCH_STORAGE_RIGHTS=true` (your plan must allow
storing results). To try the whole pipeline with no keys or network, use synthetic data:
`DISCOVERY_PROVIDERS=fixture-directory,fixture-map` (refused when `NODE_ENV=production`).
Set `DISCOVERY_CONTACT` to an email/URL so OSM can reach you. See `docs/provider-terms-register.md`.

## Scripts

`pnpm build | lint | typecheck | test | format` (Turborepo). Tests need the Docker services; they use a separate
`<db>_test` database and Redis db 14/15.

## Layout

`apps/api` (NestJS REST) · `apps/worker` (BullMQ consumers) · `apps/web` (Next.js) · `packages/contracts` (zod schemas) ·
`packages/database` (Prisma) · `packages/config` (validated env) · `packages/discovery` (provider interfaces, normalization, deduplication, providers).

## Website enrichment (Phase 3)

`POST /api/v1/companies/:id/enrich` queues a crawl; read results with `GET /companies/:id/sources` (website
decision + evidence, pages, rejected candidates, runs) and `GET /companies/:id/contacts` (`?kind=EMAIL&category=HR`).
Only e-mails literally published on the verified site are stored — never guessed; `VERIFIED` means "published on the
official site", not "mailbox exists". The crawler is SSRF-hardened, obeys robots.txt and rate-limits per domain; set
`DISCOVERY_CONTACT` so its User-Agent identifies you. `ANTHROPIC_API_KEY` (optional) enables AI only for ambiguous
cases. Design and threat model: [`docs/adr/0004-website-enrichment.md`](docs/adr/0004-website-enrichment.md).

## Jobs (Phase 4)

`POST /api/v1/companies/:id/jobs/refresh` finds a company's career pages and ATS, then reads its published jobs;
`GET /companies/:id/jobs` lists them (original application URL preserved) and `GET /companies/:id/job-sources` shows
every source with its recent checks. A failed or inconclusive check is **never** reported as "no openings"
(`vacancyKnowledge` says whether any source has actually answered). Nothing is ever applied for. Design:
[`docs/adr/0005-job-discovery.md`](docs/adr/0005-job-discovery.md).
