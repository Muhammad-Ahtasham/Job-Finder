/**
 * Closing a job on one missing sighting is how a flaky API closes real vacancies. A job that an
 * authoritative source stops listing therefore has to be MISSING in several separate checks,
 * spaced apart, before it is closed. Only a source that explicitly reports the closure closes a
 * job at once.
 */
export interface MissPolicy {
  /** Separate checks that must all miss the job before it is closed. */
  confirmations: number;
  /** The confirming check must come at least this long after the first miss. */
  minGapMinutes: number;
}

export const DEFAULT_MISS_POLICY: MissPolicy = { confirmations: 2, minGapMinutes: 10 };

export interface MissState {
  missedChecks: number;
  firstMissedAt: Date | null;
  lastMissedCheckId: string | null;
}

export const NO_MISSES: MissState = {
  missedChecks: 0,
  firstMissedAt: null,
  lastMissedCheckId: null,
};

/**
 * The miss counters after `checkId` did not list the job.
 *  - The same check can never count twice (a retried transaction, a duplicate delivery).
 *  - A second miss that follows the first too closely does not count: it is probably the same
 *    glitch seen twice, not a confirmation.
 */
export function registerMiss(
  prev: MissState,
  checkId: string,
  now: Date,
  policy: MissPolicy = DEFAULT_MISS_POLICY,
): MissState & { counted: boolean } {
  if (prev.lastMissedCheckId === checkId) return { ...prev, counted: false };
  if (prev.missedChecks === 0 || !prev.firstMissedAt) {
    return { missedChecks: 1, firstMissedAt: now, lastMissedCheckId: checkId, counted: true };
  }
  const sinceFirst = now.getTime() - prev.firstMissedAt.getTime();
  if (sinceFirst < policy.minGapMinutes * 60_000) return { ...prev, counted: false };
  return {
    missedChecks: prev.missedChecks + 1,
    firstMissedAt: prev.firstMissedAt,
    lastMissedCheckId: checkId,
    counted: true,
  };
}
