# ADR 0004 — Company website enrichment: verification, crawling, contacts

Status: accepted (Phase 3)

## Scope

For each discovered company: find its official website, **verify** it with evidence, discover its
About / Contact / Careers / Jobs / Team pages, extract the e-mails and LinkedIn URL it _publishes_, and
keep the evidence. Nothing is guessed: a missing e-mail stays missing.

Entry points: `POST /api/v1/companies/:id/enrich` (202), `GET /companies/:id/sources`,
`GET /companies/:id/contacts`, plus `GET /companies/:id/website-reviews` and
`POST /website-reviews/:id/approve|reject` so a person can overrule a decision.

## Decisions

### 1. A separate pure package: `@jobfinder/enrichment`

Like `@jobfinder/discovery`: no database, no Nest. `WebsiteEnrichmentProvider` has two methods —
`verifyWebsite({companyName, city, candidateWebsite})` → `{decision, confidence, evidence[], status}` and
`discoverSite(...)` → pages + contacts. The worker owns persistence/orchestration and can be tested with a
fake provider or an in-memory "internet" (`PageFetcher`), which is how the DB tests run without a network.
`WebsiteCandidateFinder` (optional, Brave Search behind the same storage-rights gate as discovery) proposes
sites for companies that have none; its output is only ever a _candidate_ that must be verified.

### 2. Verification is evidence-weighted, and a lookalike domain is never enough

`scoreWebsite` sums signed `Evidence` (domain≈name, name in title / site name / JSON-LD / heading, name
repeated in body, city mentioned, parked-page markers, name absent…). `OFFICIAL` needs score ≥ 0.65 **and**
the company's name on the page itself. Mapping: OFFICIAL → `VERIFIED`, REJECTED → `FAILED`,
UNCERTAIN → `UNVERIFIED`. Guard rails:

- aggregator / social / job-board domains are rejected without a request (`isAggregatorDomain`);
- an unreachable site is **UNCERTAIN + retryable**, never REJECTED; thin script-rendered shells are never
  auto-rejected (we do not execute JavaScript, so absence of text proves nothing) → human review;
- every decision is stored as a `CompanyReview` (`APPROVED` / `REJECTED` automatically, `PENDING` for
  uncertain) with its evidence; a decision a person made (`decidedManually`) is final — it is never
  overwritten, re-evaluated, or re-proposed;
- rejecting the website on record clears `website`/`domain`, its DOMAIN identity **and every page/contact
  harvested from it**.

### 3. Contacts: published, sourced, never guessed

Extraction takes only addresses literally on a page: `mailto:`, visible text, JSON-LD, Cloudflare
`data-cfemail` markup, or bracketed obfuscation (`hr [at] acme [dot] com`). Hidden elements
(`display:none`, `hidden`) are dropped — they are the classic honeypot/spam-trap place. Placeholder
domains, asset-like strings and tracking ids are filtered. **No address is ever constructed from a naming
convention, and DNS/MX records are never consulted or treated as proof a mailbox exists.**

Each `CompanyContact` keeps `sourceUrl` (+ page id), `extractedAt` (first extraction; later runs only move
`lastSeenAt`), `confidence`, `verificationStatus`, `verificationMethod`, `extractionMethod`, `category`
(HR, CAREERS, RECRUITMENT, GENERAL, OTHER) and `classifiedBy` (RULES | AI).

`verificationStatus = VERIFIED` means exactly: _published on a page of the verified official website and,
for e-mail, on the company's own domain._ It is **not** a deliverability claim. Addresses on other domains
(partners, gmail) are stored `UNVERIFIED`; AI-assisted extractions are always `UNVERIFIED`.

LinkedIn company URLs are read from the company's own site (links, JSON-LD `sameAs`) only. **linkedin.com is
never fetched** (User Agreement §8.2). With several slugs on a site only a clear winner is "primary"/VERIFIED.

### 4. Crawler security (`SafeFetcher` — the only code that touches the network)

| Threat                                  | Control                                                                                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-web schemes, credentials, odd ports | http/https only, no `user:pass@`, ports 80/443 only                                                                                                                                                                                                       |
| localhost, internal names, IP literals  | `localhost`, `*.localhost/.local/.internal/.lan/.corp/.arpa`, single-label names, unknown suffixes and **all IP-literal hosts** (decimal/hex/octal forms are canonicalised by WHATWG `URL` first) are refused                                             |
| Private / link-local / metadata ranges  | Resolved answers are checked against loopback, RFC 1918, CGNAT (Alibaba metadata), link-local (`169.254.169.254`), `192.0.0.0/24` (Oracle metadata), ULA (`fd00:ec2::254`), multicast, reserved, documentation, Teredo, 6to4; mapped/NAT64 IPv6 unwrapped |
| **DNS rebinding / mixed answers**       | Every DNS answer must be public (one private record rejects the name). The socket's `lookup` is **pinned to the validated addresses**, so a second DNS answer at connect time is never consulted; resolution happens once per hop                         |
| Redirect abuse                          | Redirects are followed manually (max 5); every hop is re-parsed, re-authorised (robots), re-rate-limited and re-resolved; HTTPS→HTTP downgrade refused; off-domain redirects are discarded by the crawler                                                 |
| Resource exhaustion                     | Per-hop timeout (10 s) covering connect + body; 1 MiB cap on **decoded** bytes (compression-bomb safe) plus raw cap and `Content-Length` pre-check; `identity/gzip/deflate/br` only                                                                       |
| Arbitrary downloads / script execution  | Only `text/html`, `application/xhtml+xml` (and `text/plain` for robots.txt); `Content-Disposition: attachment` refused; the body is parsed with cheerio (a tree builder) — **no JavaScript is ever executed**, no subresource fetched                     |
| Hammering a site                        | Per-registrable-domain spacing (default 2 s, shared across replicas via Redis `SET NX PX`), `Crawl-delay` honoured (cap 30 s), ≤ 12 requests per site, concurrency bounded by BullMQ                                                                      |
| Ignoring crawl policy                   | RFC 9309 robots.txt per origin, enforced on every hop: 4xx ⇒ allowed, unreadable/5xx ⇒ **do not crawl**; identifying `User-Agent: JobFinderBot/0.1 (+contact)`; no cookies, no auth, no Referer                                                           |

Terms of service cannot be machine-read: we honour robots.txt, crawl a handful of public pages at low
rate, never log in, never bypass walls, and a site that blocks us is recorded as `BLOCKED_ROBOTS`, not
worked around. Operators should set `DISCOVERY_CONTACT` so site owners can reach them.

### 5. AI is a fallback, and crawled text is hostile

Deterministic parsing always runs first. The optional `AiAssistant` (`ANTHROPIC_API_KEY`) is consulted only
for (a) a page type with weak/conflicting evidence, (b) a contact whose deterministic classification is
below 0.7 confidence, (c) e-mails spelled out in prose when a contact/careers page yielded none. Per site
≤ 8 calls. Prompt-injection posture: page text is passed only inside an `<untrusted_page>` block with a
system prompt saying so; the answer must be a **forced tool call whose schema is a closed enum**, re-validated
with zod; the model cannot add URLs, change a verification status, or exceed confidence 0.7; extracted
addresses must be **grounded** (local part and every domain label occur in the snippet sent) or are dropped.
Any API failure means "no opinion", never a failed run. _Not exercised against the live API in tests (no
key was available) — only against mocked responses._

### 6. Persistence, idempotency and failure tracking

- `ExtractionRun` has a unique nullable `activeKey` (= company id while QUEUED/RUNNING): the database
  guarantees one active run per company, so concurrent `POST /enrich` calls return the same run
  (`reused: true`). The job id is deterministic (`enrich-<runId>`); a reconciler re-enqueues open runs the
  queue lost; a redelivered job for a finished run is a no-op.
- Pages upsert on `(company, canonical url)`, contacts on `(company, kind, value)`, reviews on
  `(company, kind, domain)`. Re-running converges on the same rows; `extractedAt` is the _first_ extraction.
  A fetched page is never downgraded to "failed" by a later partial crawl.
- Everything for one run (pages, contacts, company statuses, run result) commits in **one transaction**.
- Failures are tracked at three levels: per page (`fetchStatus`, `httpStatus`, `errorCode`), per run
  (`errors[]`, `stats`, `COMPLETED_WITH_ERRORS`), and permanently (`FAILED` + `errorCode` after BullMQ
  attempts are exhausted; only when nothing could be decided because every site was unreachable).
- Company `emailStatus`/`careersStatus` say `MISSING` only when the crawl was unobstructed; a robots block or
  a 5xx leaves the previous value instead of asserting absence.
- Merging two companies (Phase 2) moves pages/contacts/reviews to the survivor, dropping duplicates.

## Known limitations

- No JavaScript rendering: script-only sites come back `UNCERTAIN` (→ review) with little to extract.
- Link discovery is depth 1 from the homepage plus well-known-path probes (`/contact`, `/careers`, `/about`);
  no sitemap parsing. Page typing is English-keyword based.
- Contacts that disappear from a site are not deleted (only `lastSeenAt` stops moving).
- A person-style address (`john.smith@…`) published on a contact page is stored as `OTHER`; processing
  personal data under GDPR-like regimes is the operator's responsibility.
- The AI adapter and the Brave candidate finder have only been tested against mocked HTTP.
- The per-domain limiter is a lease (`SET NX PX`), not a fair queue; under heavy contention order is not FIFO.
