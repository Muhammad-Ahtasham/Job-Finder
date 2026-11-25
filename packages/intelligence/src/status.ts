/**
 * Job status transitions. A pure function: the database layer applies what it returns.
 *
 *   OPEN     listed by a source we checked.
 *   CLOSED   an AUTHORITATIVE source (complete official API answer) stopped listing it in
 *            several separate checks, the source reported it closed, or an official copy
 *            replaced a scraped one.
 *   EXPIRED  the posting's own published expiry date has passed.
 *   UNKNOWN  nobody has seen it for a long time and nothing proves it closed.
 *
 * A failed or inconclusive request is not an event at all: it never reaches this function.
 */
export type JobStatusValue = 'OPEN' | 'CLOSED' | 'EXPIRED' | 'UNKNOWN';

export type StatusEvent =
  | { type: 'SEEN'; now: Date; expiresAt: Date | null }
  /**
   * An authoritative answer did not list the job. One such answer is not enough: closing needs
   * `required` separate checks to have missed it (the caller counts them).
   */
  | { type: 'MISSING_FROM_AUTHORITATIVE_ANSWER'; missedChecks: number; required: number }
  /** The source itself says the job is closed (not merely absent): no confirmation needed. */
  | { type: 'SOURCE_REPORTED_CLOSED' }
  | { type: 'SUPERSEDED_BY_OFFICIAL_SOURCE' }
  | {
      type: 'SWEEP';
      now: Date;
      expiresAt: Date | null;
      lastSeenAt: Date;
      /** How long without a sighting before OPEN becomes UNKNOWN. */
      staleAfterMs: number;
    };

export interface StatusChange {
  status: JobStatusValue;
  reason: string;
}

/** The change an event causes, or null when the status stays as it is. */
export function nextJobStatus(current: JobStatusValue, event: StatusEvent): StatusChange | null {
  const change = (status: JobStatusValue, reason: string): StatusChange | null =>
    status === current ? null : { status, reason };

  switch (event.type) {
    case 'SEEN':
      return event.expiresAt && event.expiresAt.getTime() <= event.now.getTime()
        ? change('EXPIRED', 'still listed, but its published expiry date has passed')
        : change('OPEN', current === 'OPEN' ? '' : `listed again (was ${current})`);

    case 'MISSING_FROM_AUTHORITATIVE_ANSWER':
      // EXPIRED and CLOSED are already final; OPEN and UNKNOWN are resolved once confirmed.
      return (current === 'OPEN' || current === 'UNKNOWN') &&
        event.missedChecks >= Math.max(1, event.required)
        ? {
            status: 'CLOSED',
            reason: `no longer listed by an authoritative source (missing from ${event.missedChecks} separate checks)`,
          }
        : null;

    case 'SOURCE_REPORTED_CLOSED':
      return current === 'OPEN' || current === 'UNKNOWN'
        ? { status: 'CLOSED', reason: 'the source reported the job as closed' }
        : null;

    case 'SUPERSEDED_BY_OFFICIAL_SOURCE':
      return current === 'OPEN' || current === 'UNKNOWN'
        ? { status: 'CLOSED', reason: 'replaced by the same vacancy from an official job board' }
        : null;

    case 'SWEEP': {
      if (current !== 'OPEN' && current !== 'UNKNOWN') return null;
      if (event.expiresAt && event.expiresAt.getTime() <= event.now.getTime()) {
        return { status: 'EXPIRED', reason: 'published expiry date passed' };
      }
      if (
        current === 'OPEN' &&
        event.now.getTime() - event.lastSeenAt.getTime() > event.staleAfterMs
      ) {
        return {
          status: 'UNKNOWN',
          reason: 'not confirmed by any check for a long time; no source reported it closed',
        };
      }
      return null;
    }
  }
}
