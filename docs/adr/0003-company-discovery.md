# ADR 0003 — Company discovery: providers, deduplication, workspace-scoped companies

Status: accepted (Phase 2)

## Decisions

### 1. Companies are workspace-scoped (deviation from `docs/ARCHITECTURE_PLAN.md`)

The plan proposed canonical companies shared across workspaces. Phase 2 stores `Company`,
`CompanySource`, `CompanyIdentity`, … **per workspace** (`workspace_id` on every row, uniqueness
per workspace). Reasons:

- The providers' terms (see `docs/provider-terms-register.md`) license data to the account that fetched
  it; showing it to another tenant would be redistribution.
- Workspace isolation then holds by construction — a deduplication hit can never reveal that another
  workspace discovered a company.
- A shared canonical layer can be added later _on top of_ these rows (a global `canonical_company_id`
  link) without rewriting them.
  Consequence: the same real company discovered by two workspaces is two rows. That is intended.

### 2. Providers sit behind `CompanyDiscoveryProvider` (`packages/discovery`)

Pure TypeScript, no database or Nest. Each provider declares `ProviderTerms` (storage policy,
attribution, bulk allowance), a rate limit, and `cityScoped` (whether results are guaranteed inside the
project's city). The factory (`createProviders`) **refuses** to enable a provider whose licence
conditions the operator has not confirmed:

| Provider                                                                                              | Status                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overpass-osm` (OpenStreetMap, ODbL)                                                                  | Implemented. City-scoped, 1 request / 5 s, cached 24 h, identifying User-Agent. Prefer a self-hosted Overpass built from a Geofabrik extract for real use.                                                                             |
| `brave-search` (web search)                                                                           | Implemented, **off unless** `BRAVE_SEARCH_API_KEY` is set **and** `BRAVE_SEARCH_STORAGE_RIGHTS=true` (Brave's terms bar storing results without a storage-rights plan). Verified only against mocked responses — no key was available. |
| Google Places                                                                                         | **Not implemented.** Its policy forbids storing names/addresses (only `place_id`, lat/lng ≤ 30 days). Can be added as live-lookup only.                                                                                                |
| Foursquare                                                                                            | **Not implemented.** No caching allowed on pay-as-you-go plans.                                                                                                                                                                        |
| `fixture-*`                                                                                           | Synthetic dev/demo data; refused in production.                                                                                                                                                                                        |
| Public Nominatim is never used. Web-search hits are _pages_: directories, social networks, job boards |
| and deep article URLs are filtered, never stored; LinkedIn is never fetched.                          |

### 3. PostgreSQL is the source of truth; BullMQ only delivers

`DiscoveryTask` rows (provider × query) hold status, attempts, cursor and last error; every attempt is
logged in `DiscoveryTaskAttempt`. Job ids are deterministic (`plan-<runId>`, `task-<taskId>`) and a
reconciler (every 30 s) re-delivers anything the database says is open but Redis lost (API crash after
commit, flushed Redis, un-finalized run).

- One queue **per provider** carries that provider's limiter and concurrency → provider-specific rate limits.
- Retries: exponential backoff with ±30 % jitter, honouring `Retry-After`. HTTP 429 pauses the provider's
  queue without consuming an attempt (bounded). Non-retryable errors (auth, bad request) fail immediately.
- Pagination cursors are persisted after each page, so a retry resumes instead of refetching.
- Cancellation is cooperative: queued/retrying tasks are cancelled at once, running tasks stop at the next
  page boundary, partial results are kept.

### 4. Idempotency and concurrency

Each candidate is persisted in **one transaction** that first takes a per-workspace advisory lock. Unique
keys are the safety net: `CompanyIdentity(workspace,type,scope,value)`, `CompanySource(workspace,provider,
sourceKey)`, `DiscoveryResult(run,provider,sourceKey)`. Replaying a page therefore writes nothing.

### 5. Deduplication never merges an uncertain match

`DefaultCompanyDeduplicationService` (thresholds in `DEDUPE_THRESHOLDS`):

- **Auto-match** only on: same provider id, same registration number, same domain with a similar name, or
  exact name + same city corroborated by address/phone (and no conflicting domains).
- **Review** (candidate kept as its own company + a `MatchReview`): exact name without corroboration, same
  domain but different names, conflicting domains, fuzzy-similar names, similar address + plausible name.
- **Never** matched: different registration numbers; same name in different cities.
- A project's city is only assumed for providers with `cityScoped = true`; a web hit's city stays unknown.
- Fuzzy matches also require the _distinguishing_ tokens to resemble each other, so two names sharing a
  leading word ("Fixture Zeta" / "Fixture Delta") are not flagged.
  Humans resolve reviews via `POST /reviews/:id/merge|dismiss`; a dismissed pair is never raised again.

## Defects found by running against real services (and fixed)

Unit tests with mocked HTTP passed while these were broken — keep live smoke runs in the loop:

1. OSM has no relation named exactly "Lahore" (it is "Lahore District" / "Lahore City Tehsil", Urdu in
   `name`, English only in `name:en`) → the city now resolves via `name:en` + suffixes and an unresolved
   city fails loudly instead of returning zero results.
2. Overpass id lists need `rel(id:1,2)`; `rel(1,2)` was an HTTP 400.
3. Jaro-Winkler flagged names that merely share a leading word (see 5).
4. Nest runs bootstrap hooks concurrently: the plan worker could start before provider queues existed.

## Known limitations

- OSM coverage of businesses is thin; name-regex keyword queries rarely match office names. Expect modest recall.
- The public Overpass instance was saturated (429/502/timeouts) during testing, so no live OSM result set
  was obtained — retry/backoff/cancel were exercised against those real failures instead.
- `candidatesFiltered` can over-count if a worker crashes between persisting a page and advancing its cursor.
- Blocking for deduplication uses name tokens/prefix (cap 200); no `pg_trgm` yet.
