# ADR 0008 — Scheduled company and job monitoring

## Status

Accepted (Phase 8)

## Context

Discovery (Phase 4) reads a company's jobs once, on request. Vacancies come and go, so the system
must keep looking: discover new jobs, notice vanished ones and changes, remember what it saw — and
must never mistake its own failures (a flaky API, an outage) for a company closing a vacancy.

## Decisions

### Schedules

`monitoring_schedules` has one row per thing watched, identified by `scope_key`
(`<kind>:<source id or company id>`):

| Kind          | Watches                                | Default interval |
| ------------- | -------------------------------------- | ---------------- |
| `ATS_BOARD`   | Greenhouse / Lever / Ashby public APIs | 12 hours         |
| `CAREER_PAGE` | a company career page read from HTML   | 24 hours         |
| `WEBSITE`     | is the website up, and still the same? | 7 days           |

- Configurable per deployment (`MONITOR_ATS_INTERVAL_HOURS`, `MONITOR_CAREER_PAGE_INTERVAL_HOURS`,
  `MONITOR_WEBSITE_INTERVAL_HOURS`) and per schedule (`PATCH /monitoring/:id`, 1 hour – 30 days).
- Created automatically when discovery records a source (and for the website); existing schedules
  — intervals, pauses — are never overwritten. A source found while its company is paused starts
  paused.
- On/off at three levels: `MONITOR_ENABLED=false` (global kill switch, schedules kept),
  `PUT /companies/:id/monitoring` (all of a company's schedules), `PATCH /monitoring/:id` (one).
- Next runs are jittered ±10 % so a batch added together does not hit one ATS at the same minute
  forever. After a failure the retry is sooner (30 min, doubling, never later than the normal
  interval).

### Execution

A maintenance job (`monitoring-tick`, every minute) selects due, enabled, unlocked schedules,
**claims** each with a guarded update (`locked_until`), and enqueues it on the `monitoring` BullMQ
queue. The database is the source of truth: a lost message is picked up again when the claim
lapses (`MONITOR_LOCK_MINUTES`). Two ticks or two workers racing for a schedule enqueue it once.
Provider calls keep the existing per-host Redis rate limiting; website fetches use the SSRF-guarded,
robots-aware page fetcher.

### Failures are not job state

- A failed or inconclusive check changes **no** job: no status change, no "missing" record. It is
  recorded on the `job_checks` row (`FAILED`, error code) and on the schedule
  (`consecutive_failures`, `last_error_*`), which are separate from `last_success_at`.
- The website check is isolated further: a website being down never touches jobs, the company's
  website status or its sources. After `MONITOR_WEBSITE_FAILURES_BEFORE_ALERT` (3) consecutive
  failures one "website unavailable" notice is sent per outage.

### A missing job is checked again

An authoritative answer that does not list a job only **starts a count** (`jobs.missed_checks`).
The job is closed when `MONITOR_MISS_CONFIRMATIONS` (2) **separate** checks have missed it, the
confirming check coming at least `MONITOR_MISS_MIN_GAP_MINUTES` after the first (so one glitch
seen twice in a burst is not a confirmation) — and the scheduler looks again after
`MONITOR_RECHECK_MINUTES` (30) instead of waiting 12 hours. Seeing the job again voids the count.
A non-authoritative answer (a partial page) never counts. The exception is a source that
**explicitly reports closure** (`NormalizedJob.explicitlyClosed`): that closes at once. The rule is
the pure function `nextJobStatus` plus `registerMiss`, used by scheduled and manual checks alike.

### Material changes and history

Every sighting, change, miss and status change is appended to `job_observations`
(Phase 5); `job_checks` gains `trigger` (MANUAL | SCHEDULED), `schedule_id`, `jobs_missing` and
`pending_confirmation`. A change in title, location, employment type, workplace type or
application URL is _material_ (recorded as `material change: ...` and announced); description-only
edits are recorded but not announced. The website check stores `website_checks` rows (status,
final domain, content hash) and flags `DOMAIN_CHANGED` / `CONTENT_CHANGED`; only a move to another
domain is announced. Last successful verification is `monitoring_schedules.last_success_at` and
`job_sources.last_success_at`.

### Notifications

`@jobfinder/monitoring` defines events (`NEW_JOB`, `JOB_CLOSED`, `JOB_CHANGED`,
`WEBSITE_CHANGED`), plain-text rendering, and a `NotificationChannel` interface. In-app
notifications are rows; email is a registered channel that is a stub until a mail provider is
configured (`UnconfiguredEmailChannel` is skipped, never an error), so email alerts can be added
without touching producers.

**Idempotent:** a notification is unique per `(workspace, user, dedupe key)`; creating it is
`INSERT … ON CONFLICT DO NOTHING`. Keys identify the _fact_: `job-new:<job>` (a job is new once),
`job-closed:<job>:<closed at>`, `job-changed:<job>:<content hash>`, `website-moved:<company>:<new
domain>`, `website-down:<company>:<outage start>`. Events are emitted inside the transaction that
records the change, so a job and its notification commit together; retries, re-runs and racing
workers insert nothing new. Other channels claim a notification with a guarded update before
sending (at most once; a failed send releases the claim).

Further rules: the **first check of a source is a baseline** — its jobs are recorded, not
announced; members receive notifications according to `notification_preferences` (default: in-app
on, email off); every query is scoped by workspace and user.

### API

`GET /monitoring`, `PATCH /monitoring/:id`, `POST /monitoring/:id/run`,
`GET|PUT /companies/:id/monitoring`, `GET /notifications`, `POST /notifications/:id/read`,
`POST /notifications/read-all`, `GET|PUT /notification-preferences`.

## Consequences

- A vacancy that really disappears is closed about `MONITOR_RECHECK_MINUTES` later than before;
  that delay is the price of never closing real vacancies on a bad response.
- A job that is closed, reopened and closed again produces a new closure notice (new closure
  time); a website that moves A → B → A → B announces the second move to B only once.
- Notification volume is bounded by facts, not by checks.
