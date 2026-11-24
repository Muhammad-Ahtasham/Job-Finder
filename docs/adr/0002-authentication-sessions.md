# ADR 0002 — Authentication: server-side sessions

Status: accepted (Phase 1)

## Decision

- **Passwords:** Argon2id (19 MiB, t=2, p=1 — OWASP minimum profile). Parameters live in the hash; `needsRehash` upgrades hashes on login.
- **Sessions:** opaque 256-bit random token in an `HttpOnly`, `SameSite=Lax`, `Path=/` cookie (`Secure` required in production; prefer the `__Host-` prefix there). Only the SHA-256 of the token is stored (`sessions.token_hash`).
- **Lifetimes:** absolute expiry (`SESSION_ABSOLUTE_TTL_HOURS`, default 7 d), idle expiry (`SESSION_IDLE_TTL_HOURS`, default 24 h). The worker purges dead rows hourly.
- **Rotation:** the token is rotated on login (new session, presented one revoked → no fixation) and after `SESSION_ROTATE_AFTER_MINUTES` of use. The previous token stays valid for 30 s so parallel requests do not fail; rotation is compare-and-swap so concurrent requests cannot orphan the cookie.
- **CSRF:** SameSite=Lax plus an `Origin`/`Referer` allow-list guard on non-GET requests (`WEB_ORIGIN`).
- **Enumeration/timing:** login returns one generic 401; unknown emails still burn an Argon2 verification. Registration of an existing email returns 409 (a deliberate usability trade-off; revisit if enumeration matters).
- **Rate limiting:** global limiter + stricter `AUTH_RATE_LIMIT_PER_MINUTE` on login/register (in-memory; move to Redis storage before multiple API replicas).
- **Frontend:** the browser talks only to the web origin; Next rewrites `/api/*` to the API, keeping the cookie first-party. The dashboard auth gate is client-side UX only — the API is the authority.

## Consequences

- Instant revocation (logout, future "sign out everywhere", password change) at the cost of one DB lookup per request.
- Behind a reverse proxy, configure Express `trust proxy` before relying on client IPs (rate limiting, session metadata).
