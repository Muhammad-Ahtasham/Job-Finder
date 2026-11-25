/**
 * Scheduling rules for monitoring. Pure functions: the worker applies what they return.
 *
 * Three things are watched: ATS boards (public APIs, checked twice a day by default), custom
 * career pages (daily) and company websites (weekly). Every interval is configurable, per
 * deployment (environment) and per schedule (API).
 */
export type MonitoringKind = 'ATS_BOARD' | 'CAREER_PAGE' | 'WEBSITE';
export const MONITORING_KINDS: readonly MonitoringKind[] = ['ATS_BOARD', 'CAREER_PAGE', 'WEBSITE'];

export interface IntervalDefaults {
  atsMinutes: number;
  careerPageMinutes: number;
  websiteMinutes: number;
}

/** Initial frequencies: ATS 12 h (the spec allows 12-24), career pages 24 h, websites 7 days. */
export const DEFAULT_INTERVALS: IntervalDefaults = {
  atsMinutes: 12 * 60,
  careerPageMinutes: 24 * 60,
  websiteMinutes: 7 * 24 * 60,
};

/** A schedule can be set between 1 hour and 30 days (the API enforces it). */
export const MIN_INTERVAL_MINUTES = 60;
export const MAX_INTERVAL_MINUTES = 30 * 24 * 60;

/** Providers that read a vendor's public API; everything else is a page read from HTML. */
const ATS_PROVIDERS = new Set(['greenhouse', 'lever', 'ashby']);

export const kindForProvider = (providerId: string): 'ATS_BOARD' | 'CAREER_PAGE' =>
  ATS_PROVIDERS.has(providerId) ? 'ATS_BOARD' : 'CAREER_PAGE';

export function defaultIntervalMinutes(kind: MonitoringKind, defaults: IntervalDefaults): number {
  return kind === 'ATS_BOARD'
    ? defaults.atsMinutes
    : kind === 'CAREER_PAGE'
      ? defaults.careerPageMinutes
      : defaults.websiteMinutes;
}

/** One schedule per thing watched: the source for boards/pages, the company for its website. */
export const scopeKey = (kind: MonitoringKind, id: string): string => `${kind}:${id}`;

const MINUTE_MS = 60_000;

/**
 * After a check that got an answer: one interval later, ±10 % so that a thousand companies added
 * together do not all hit their ATS at the same minute forever.
 */
export function nextRunAfterAnswer(
  now: Date,
  intervalMinutes: number,
  random: () => number = Math.random,
): Date {
  const jitter = 1 + (random() * 2 - 1) * 0.1;
  return new Date(now.getTime() + Math.round(intervalMinutes * jitter) * MINUTE_MS);
}

/**
 * After a failed check: retry sooner than the full interval, with exponential backoff
 * (base, 2×base, 4×base, ...), never later than the normal next run. A failure says nothing
 * about the jobs, so it must not push the next look further away than it would have been.
 */
export function nextRunAfterFailure(
  now: Date,
  intervalMinutes: number,
  consecutiveFailures: number,
  baseMinutes: number,
): Date {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 16);
  const delay = Math.min(baseMinutes * 2 ** exponent, intervalMinutes);
  return new Date(now.getTime() + delay * MINUTE_MS);
}

/** A job is waiting for a confirming check: look again soon, but never later than planned. */
export function nextRunForRecheck(now: Date, planned: Date, recheckMinutes: number): Date {
  const soon = new Date(now.getTime() + recheckMinutes * MINUTE_MS);
  return soon < planned ? soon : planned;
}

export type ScheduleHealth = 'HEALTHY' | 'DEGRADED' | 'FAILING' | 'PAUSED' | 'PENDING';

/** A readable state for dashboards: failures are provider problems, not job problems. */
export function scheduleHealth(s: {
  enabled: boolean;
  lastRunAt: Date | null;
  consecutiveFailures: number;
}): ScheduleHealth {
  if (!s.enabled) return 'PAUSED';
  if (!s.lastRunAt) return 'PENDING';
  if (s.consecutiveFailures >= 5) return 'FAILING';
  if (s.consecutiveFailures >= 1) return 'DEGRADED';
  return 'HEALTHY';
}
