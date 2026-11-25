# Provider terms register

Reviewed 2026-11-24 from official pages (see `docs/ARCHITECTURE_PLAN.md` §6). Update `reviewedAt` whenever terms are re-read; re-check before enabling in production.

| Provider                     | Storage / caching                                                      | Bulk extraction                                | Phase 2 status                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Places API            | `place_id` indefinitely; lat/lng ≤ 30 days; no storing names/addresses | Prohibited                                     | **Not implemented** (would be live lookup + attribution only)                                                                                        |
| Foursquare Places            | PAYG/sandbox: none; enterprise: ≤ 24 h local device                    | Prohibited                                     | **Not implemented** (needs a negotiated licence)                                                                                                     |
| Brave Search API             | No storing/caching unless plan grants storage rights                   | n/a                                            | Implemented, **gated** by `BRAVE_SEARCH_STORAGE_RIGHTS=true`; mock-tested only                                                                       |
| OSM Nominatim (public)       | Must cache; ≤ 1 req/s                                                  | Prohibited (systematic queries)                | **Never used**                                                                                                                                       |
| OSM Overpass (public)        | Cache; ≤ 10k queries/day                                               | Discouraged                                    | Implemented: city-scoped, ~6 queries/run, 5 s spacing, 24 h cache, identifying UA. Public instance was saturated in testing — self-host for real use |
| Greenhouse Job Board API     | Not stated                                                             | Not stated (may be rate limited)               | Later phase                                                                                                                                          |
| Lever Postings API           | Not stated                                                             | Postings are public                            | Later phase                                                                                                                                          |
| Ashby Public Job Posting API | Not stated                                                             | Not stated                                     | Later phase                                                                                                                                          |
| LinkedIn                     | —                                                                      | Scraping/bots prohibited (User Agreement §8.2) | Never fetched; search hits on linkedin.com are discarded                                                                                             |

Brave Search API facts verified against its docs on 2026-11-24: `GET https://api.search.brave.com/res/v1/web/search`,
auth header `X-Subscription-Token`, `country` (2-letter), `count` ≤ 20, `offset` ≤ 9 (page index).

Operational notes: OSM data is ODbL — keep the attribution `© OpenStreetMap contributors (ODbL 1.0)` wherever it is
shown (the API returns it per provider in run progress) and consider share-alike for derived databases.

## Phase 3 additions

| Source / service                | Use                                                                     | Status                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Company websites (public HTML)  | Verify the site; read About/Contact/Careers pages and published e-mails | Fetched with `JobFinderBot`, robots.txt (RFC 9309) obeyed on every hop, ≥ 2 s between requests per domain, ≤ 12 requests per site, no login/bypass  |
| LinkedIn                        | Company URL only, read from the company's own website                   | **Never fetched** (User Agreement §8.2); URLs are recorded as UNVERIFIED/“linked from the site”                                                     |
| Brave Search (candidate finder) | Propose websites for companies that have none                           | Same gate as discovery: needs `BRAVE_SEARCH_STORAGE_RIGHTS=true`. Each proposal is verified before use. Mock-tested only                            |
| Anthropic API (optional)        | Second opinion on ambiguous page/contact classification                 | Off unless `ANTHROPIC_API_KEY` is set. Sends short page snippets (≤ 2 000 chars) — do not enable if site content must not leave your infrastructure |
