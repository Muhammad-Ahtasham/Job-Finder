# ADR 0007 — Export system

## Status

Accepted (Phase 7)

## Context

Users need companies and jobs as CSV or Excel files. Exports can be large, must respect the same
filters as the tables, must never cross workspaces, and must be safe to open in a spreadsheet.

## Decisions

### Asynchronous, durable

`POST /api/v1/exports` validates the request, writes an `exports` row (the source of truth:
type, format, scope, filters, status, progress, file metadata) and enqueues a BullMQ job
(`exports` queue, job id `export-<id>`). The worker builds the file; the API never does.

- Status: `QUEUED → RUNNING → COMPLETED | FAILED`, and `EXPIRED` once the file is deleted.
- Progress: `rows_total` (counted first) and `rows_processed` (updated per batch of
  `EXPORT_BATCH_SIZE`), exposed as `progress.percent`.
- Failures: transient errors are retried by BullMQ (`EXPORT_MAX_ATTEMPTS`, exponential backoff) and
  shown as `QUEUED` + `RETRYING` meanwhile; the last failure sets `FAILED` with a readable
  message. Permanent ones (project deleted, over `EXPORT_MAX_ROWS`) fail at once with a code.
- Lost jobs: a maintenance job (`reconcile-exports`, every 30 s) re-enqueues exports stuck in
  `QUEUED`/`RUNNING`, so a Redis flush never strands a request.
- A workspace may have at most `EXPORT_MAX_ACTIVE_PER_WORKSPACE` exports in progress (HTTP 429).

### Six export types, one request

`{ type: COMPANIES | JOBS, format: CSV | XLSX, projectId?, filters? }`

| #   | Export              | Request                                    |
| --- | ------------------- | ------------------------------------------ |
| 1   | All companies       | `type: COMPANIES`                          |
| 2   | Filtered companies  | `type: COMPANIES, filters`                 |
| 3   | Project companies   | `type: COMPANIES, projectId`               |
| 4   | All jobs            | `type: JOBS`                               |
| 5   | Filtered jobs       | `type: JOBS, filters`                      |
| 6   | Project job matches | `type: JOBS, projectId` (best match first) |

Filters are strict zod schemas (unknown keys are rejected). The company and job filters are
implemented once in `@jobfinder/exports` (`companyWhere`, `jobWhere`) and used by both the table
endpoints and the worker, so an export always agrees with what the table shows.

### Object storage

`@jobfinder/storage`: one interface (`put`/`get`/`delete`) with a filesystem driver (default,
`.data/exports`) and an S3-compatible driver (AWS S3, MinIO, R2). Files live under
`exports/<workspace id>/<export id>.<ext>`; keys are validated against traversal and are never
returned to clients. Files are deleted `EXPORT_RETENTION_DAYS` after creation by the same
maintenance job; the history row stays (`EXPIRED`).

### Authorization and short-lived downloads

- Every export query is scoped by workspace; another workspace's export is a 404 (list, get and
  download alike). Creating needs role MEMBER; a project from another workspace is a 404.
- `GET /exports/:id/download` (session required) answers `302` to a link — or JSON with
  `?mode=json` — that serves the file for `EXPORT_LINK_TTL_SECONDS` (default 60). The link is
  `…/exports/:id/file?expires=…&signature=…`, an HMAC-SHA256 over the export id and expiry with
  `EXPORT_LINK_SECRET` (required in production). It cannot be forged, extended, or reused for a
  different export. The file route is public by design (the signature is the credential), sends
  `Cache-Control: no-store`, `Content-Disposition: attachment` and `nosniff`, and streams from
  storage, so storage itself is never exposed.
- `409` while the export is unfinished or failed, `410` once it expired or its file is gone.

### Spreadsheet formula injection

Company names, job titles and URLs come from the internet. Every text cell in CSV and XLSX is
neutralised by `sanitizeCell`: a value starting with `=`, `+`, `-`, `@` (also after leading
whitespace) or a tab/CR/LF gets a leading apostrophe; control characters are removed. Real
numbers are written as numbers and never touched. XLSX text is always written as a string cell,
never a formula. CSV carries a UTF-8 BOM so Excel reads non-ASCII text correctly.

## Consequences

- Output memory is bounded: rows are streamed batch by batch to a temp file, then uploaded.
- A neutralised cell shows a leading `'` in a spreadsheet; that is the price of safety.
- Offset paging is used for stable ordering; an export is a snapshot only as far as the data does
  not change while it runs.
- The S3 driver is exercised against MinIO manually; automated tests use the filesystem driver.
