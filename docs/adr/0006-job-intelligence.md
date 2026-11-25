# ADR 0006 — Job intelligence and hybrid AI matching

## Status

Accepted (Phase 5)

## Context

Phase 4 stores raw postings. Phase 5 turns them into structured, searchable data and scores them
against search projects, without letting a language model invent facts or make decisions that
must be reproducible.

## Decisions

### Rules first, AI as a validated supplement

`@jobfinder/intelligence` (pure TypeScript, no DB/Nest) contains both halves:

| Deterministic (never AI)                              | AI (optional, behind `AiProvider`)                  |
| ----------------------------------------------------- | --------------------------------------------------- |
| URL validation, domain normalization, date validation | Job title normalization                             |
| Job deduplication (fingerprints, official-twin rule)  | Skill extraction                                    |
| Status transitions (`nextJobStatus`)                  | Job description parsing (experience/education/cert) |
| Persistence, observation history                      | Role classification                                 |
| Score arithmetic, weights, fit rules                  | Semantic role similarity, match explanation         |
| Salary extraction (AI is never trusted for it)        |                                                     |

Rules always produce a complete analysis. The AI may only **add** information, and only after
validation; it never overrides a rule-derived value. With no `ANTHROPIC_API_KEY`
(or `INTELLIGENCE_AI_ENABLED=false`) everything still works on rules.

### AI safety

- One provider interface (`AiProvider.complete`); the Anthropic implementation forces a tool call
  whose input schema is generated from the zod schema.
- Every answer is re-validated with zod at runtime: enums, bounded numbers (a score of 1.7 is
  **rejected**, not clamped), bounded lengths, no URLs in any string field. No schema has a URL
  field at all, so an AI can never introduce an application link.
- Grounding: a skill needs a quote that occurs in the posting and shows the skill; an experience
  figure must appear as digits inside its quote; a normalized title may only use words from the
  posting or a role vocabulary; seniority needs a quote from the original title; an explanation
  may only contain numbers present in the facts it was given.
- Scraped text is fenced in `<untrusted_…>` blocks with angle brackets stripped, the system prompt
  says it is data, and postings containing text addressed to an AI ("ignore previous
  instructions…") are analysed by rules only.
- Every result records provider, model and prompt version (`analysis_*`, `job_matches.provider/model/prompt_version`).
  Bump `PROMPT_VERSIONS` when a prompt changes.

### Nothing is invented

Seniority comes from the title only. Salary only from an explicit currency + amount in a salary
context ("$5 million in funding" is not a salary); an ambiguous symbol (`$`, `Rs`) is stored as
written, not guessed to be USD/PKR. Unknown experience / location / skills are `null`/`UNKNOWN`,
and an unknown matching component is **left out** of the weighted mean (and lowers confidence)
instead of counting as zero.

### Job status

`OPEN`, `CLOSED`, `EXPIRED`, `UNKNOWN`, decided only by `nextJobStatus`:

- `CLOSED`: an **authoritative** answer (complete official API response) stopped listing it, or an
  official copy replaced a scraped one. A failed or inconclusive request is not an event; a
  non-authoritative page that no longer lists a job only records a `MISSING` observation.
- `EXPIRED`: the posting's own `validThrough` has passed (sweep, or when seen already expired).
- `UNKNOWN`: an OPEN job unconfirmed for `JOBS_STALE_AFTER_DAYS` (default 14). Never `CLOSED`.
- Listed again → `OPEN` (a job can reopen).

### History

`job_observations` is append-only: `FIRST_SEEN`, `SEEN`, `CHANGED` (field diffs), `MISSING`,
`STATUS_CHANGED` (from/to/reason), `ANALYZED`. Closed jobs and their skills, requirements and
matches are kept. `GET /jobs/:id/history` reads it.

### Pipeline

1. `persistCheck` validates URL/dates, stores `content_hash`, writes observations, applies
   transitions. A changed posting clears `analysis_hash`.
2. The `sweep-intelligence` maintenance job (every 30 s) applies time-based transitions, analyses
   up to `INTELLIGENCE_BATCH_SIZE` pending jobs (`analysis_hash IS NULL`) and enqueues matching
   for the affected workspaces' projects. The database is the source of truth, so a lost queue
   message only delays work.
3. `job-matching` queue (`match-<projectId>` job ids): scores every OPEN, analysed job of the
   project's companies. The API enqueues it when matching preferences change.

### Matching

`score = 100 · Σ wᵢ·sᵢ / Σ wᵢ` over the components that could be judged. Default weights
role 0.30, skills 0.40, experience 0.20, location/workplace 0.10, configurable per project
(`PUT /projects/:id/matching-preferences`; relative values, rescaled to sum to 1).

- role: token/synonym overlap with target roles (floor 0.5 for the same role family); when AI
  is available `0.4·rules + 0.6·AI`.
- skills: `0.8·required coverage + 0.2·preferred coverage` against the project's target skills.
- experience: years (and wanted seniorities) vs. the job's stated years/seniority.
- location: remote / city / country match, discounted when the workplace type is unwanted.

**Repeatability.** The score is a pure function. `job_matches.input_hash` covers the engine
version, job analysis, project, preferences and the AI key; an unchanged hash means no work. The
only non-deterministic input, the AI role similarity, is stored with a hash of its own inputs and
reused, so changing weights never re-asks the model. If the AI fails, the rules result is stored
with the hash of what was actually computed, so a later sweep retries.

Stored per match: score, component scores, matched/missing skills, experience and location fit,
explanation (+ whether rules or AI wrote it), confidence, provider/model/prompt version, weights
applied, and `job_match_evidence` rows (supporting the score item by item).

## Consequences

- Job content changes cost one re-analysis; unchanged content costs nothing.
- Explanations from the AI are best-effort; the deterministic one is always stored if the AI is
  unavailable or rejected.
- Salary parsing is conservative: it misses unusual formats rather than risk a wrong number.
