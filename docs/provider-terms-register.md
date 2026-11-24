# Provider terms register

Reviewed 2026-11-24 from official pages (see `docs/ARCHITECTURE_PLAN.md` §6). **No provider is integrated yet.** Update `reviewedAt` whenever terms are re-read; re-check before enabling in production.

| Provider                     | Storage / caching                                                      | Bulk extraction                                | Notes                                                     |
| ---------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| Google Places API            | `place_id` indefinitely; lat/lng ≤ 30 days; no storing names/addresses | Prohibited                                     | Live lookup + attribution only                            |
| Foursquare Places            | PAYG/sandbox: none; enterprise: ≤ 24 h local device                    | Prohibited                                     | Needs a negotiated licence for persistence                |
| Brave Search API             | No storing/caching unless plan grants storage rights                   | n/a                                            | Confirm current terms/pricing first                       |
| OSM Nominatim (public)       | Must cache; ≤ 1 req/s                                                  | Prohibited (systematic queries)                | ODbL; use planet/extract for bulk                         |
| OSM Overpass (public)        | Cache; ≤ 10k queries/day                                               | Discouraged                                    | Prefer self-hosted extract; ODbL                          |
| Greenhouse Job Board API     | Not stated                                                             | Not stated (may be rate limited)               | GET endpoints unauthenticated                             |
| Lever Postings API           | Not stated                                                             | Postings are public                            | Try global + EU hosts                                     |
| Ashby Public Job Posting API | Not stated                                                             | Not stated                                     | Limits/terms undocumented on page                         |
| LinkedIn                     | —                                                                      | Scraping/bots prohibited (User Agreement §8.2) | Never fetched; URLs only from company sites or user input |
