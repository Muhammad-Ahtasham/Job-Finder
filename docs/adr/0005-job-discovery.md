# ADR 0005 — Career page discovery and job provider integrations

Status: accepted (Phase 4)

## Scope

Find a company's recruitment pages, identify the applicant-tracking system (ATS) behind them, and read
the jobs it publishes — through the ATS's official public API where there is one, and from the HTML of
the career page where there is not. Nothing is applied for: the platform only **reads** published jobs and
keeps the original application URL.

Entry points: `POST /api/v1/companies/:id/jobs/refresh` (202), `GET /companies/:id/jobs`,
`GET /companies/:id/job-sources`.

## Decisions

### 1. Package `@jobfinder/jobs` (pure TypeScript)

| Piece                                      | Role                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobDiscoveryProvider`                     | `identify(url) → board`, `fetchJobs(board) → JobFetchResult`. One adapter per ATS plus the generic HTML fallback.                            |
| `JobProviderRegistry`                      | Registers providers, routes a URL to the adapter that owns it.                                                                               |
| `ATSDetectionService`                      | Recognises ATS platforms from a URL, from links, and from embeds (iframe / script / inline URL) in raw HTML. Unsupported ATSs are named too. |
| `CareerPageDiscoveryService`               | Nominates pages from homepage links, known pages and well-known paths, then **judges them by content** (below).                              |
| `GreenhouseProvider` / `Lever…` / `Ashby…` | API adapters built from the vendors' documentation and checked against live public boards (see §2).                                          |
| `GenericHtmlJobProvider`                   | JSON-LD `JobPosting` → microdata → repeated posting-link structures → (only if needed) AI.                                                   |

### 2. ATS endpoints (from the official docs; verified live 2026-11-25)

| ATS        | Docs                                               | Endpoint used                                                                        | Board id comes from            | Pagination                                      |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------- |
| Greenhouse | developers.greenhouse.io/job-board.html            | `GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`                   | `boards.greenhouse.io/{token}` | None (one response); `meta.total` cross-checked |
| Lever      | github.com/lever/postings-api                      | `GET api.lever.co/v0/postings/{site}?mode=json&skip=&limit=` (EU: `api.eu.lever.co`) | `jobs.lever.co/{site}`         | `skip`/`limit`, short page ends it              |
| Ashby      | developers.ashbyhq.com/docs/public-job-posting-api | `GET api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}`                         | `jobs.ashbyhq.com/{name}`      | None (one response)                             |

No other endpoint is called; the application-submission endpoints (Greenhouse POST, Lever POST) are never
used. Board identifiers are validated (`[A-Za-z0-9_.-]`, ≤ 100) before they enter an API URL; API hosts are
constants, never taken from crawled content. Greenhouse `content` is entity-escaped HTML and is decoded then
reduced to plain text — HTML is never stored. Two details found by running the real APIs: Ashby returns an `id`
the documented sample omits (the URL's last segment is the fallback), and Greenhouse job lists carry
`first_published` (used as the publication date; `updated_at` is deliberately not).

Rate limiting: every API request first takes a lease on its host from the shared Redis limiter
(`JOBS_API_MIN_INTERVAL_MS`, default 1 s per vendor domain, across all worker replicas). Errors map to
`BOARD_NOT_FOUND` (404, not retryable), `RATE_LIMITED` (honours `Retry-After`), `UNAVAILABLE`/`TIMEOUT`
(retryable), `BAD_RESPONSE` (a shape we do not understand is never read as an empty board).

### 3. Career pages are recognised by what they say, not only where they live

A URL (`/careers`, `/career`, `/jobs`, `/join-us`, `/work-with-us`, …) or anchor text ("We're hiring", "Join the
team") only **nominates** a page. Acceptance needs content evidence: structured `JobPosting` data, recruitment
phrasing, a careers heading, ≥ 3 posting-shaped links, or an ATS embed. So `/company/people-and-culture` linked as
"Join the team" with a job list is accepted, and `/careers` that turns out to be a blog post is rejected. A link
into an ATS host is accepted without fetching (the provider API verifies it). External portals are kept when
their content is recruitment. Platforms we recognise but have no adapter for (Workable, SmartRecruiters,
BambooHR, …) are stored as `JobSource.status = UNSUPPORTED` and never scraped.

### 4. Failed ≠ zero vacancies (the central rule)

`JobFetchResult.outcome` is one of:

- `JOBS` — jobs found;
- `NO_OPENINGS` — the source **positively** said none (empty API answer, or the page states it);
- `INCONCLUSIVE` — a page was read but nothing extractable and it does not say "none";
- `FAILED` — the request failed (404 board, 5xx, timeout, robots block, malformed answer).

Each fetch is stored as a `JobCheck` (outcome, counts, error code, HTTP status, retryable, evidence). Only an
**authoritative** answer (official API, complete, every entry readable) may close jobs; a `FAILED`, `INCONCLUSIVE`,
partial-pagination or generic-HTML result changes no job's status. The API exposes `vacancyKnowledge: KNOWN |
UNKNOWN` so an empty list is never mistaken for "no vacancies". A run where nothing could be found says
`NO_JOB_SOURCE_FOUND … does not mean the company has no vacancies`; a run where every source was unreachable is
retried by the queue and ends `FAILED` only after the attempts are used.

### 5. Duplicates and original URLs

- `Job` is unique on `(sourceId, externalId)` (the provider's id; generic pages: hash of the job URL), so a re-run
  updates in place; the same id twice in one response is collapsed.
- The same vacancy listed by the company site **and** its ATS (same normalized title + primary location) is kept once:
  a scraped job is not imported when an official source has it, and an official job closes a scraped twin. The
  fingerprint is deliberately not unique — two real openings with the same title stay separate within a source.
- `applicationUrl` / `sourceUrl` are stored exactly as published (query strings included). Descriptions are plain text.

### 6. AI is last, and grounded

Only when the generic parser finds nothing on a page that scores as recruitment content. Same safety model as
Phase 3: page text inside `<untrusted_page>`, forced tool call, zod-validated; a returned title must occur in the
page text and a returned URL must be one of the page's own links — otherwise it is dropped. AI-extracted jobs are
tagged `extraction = AI` and are never authoritative. _Verified against mocked responses only (no API key)._

### 7. Operations

`JobRun` (one active per company via unique `activeKey`, like `ExtractionRun`) → BullMQ queue `job-discovery` →
`JobDiscoveryProcessor`; each source commits in its own transaction, so one broken board never discards another.
Sources found earlier are re-checked even if career-page discovery fails this time. A reconciler re-enqueues runs
the queue lost. Merging companies moves job sources and jobs to the survivor. Career pages are stored as Phase 3
`CompanyPage` rows so both views agree. Crawling requires a `VERIFIED` website (Phase 3).

## Known limitations

- Generic extraction reads listings only; descriptions and dates are not fetched from each job's own page.
- No JavaScript rendering: a script-built career page is `INCONCLUSIVE`, never "no jobs".
- Employment type is unknown for Greenhouse (the Job Board API has no such field); workplace type is only inferred
  from a location that _is_ "Remote".
- Lever boards with > 5 000 postings are read partially and marked non-authoritative (nothing is closed).
- Compensation fields are not collected. Only Greenhouse, Lever and Ashby have adapters.
