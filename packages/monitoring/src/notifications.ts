/**
 * Notification events and the channel abstraction. Pure TypeScript: no database, no network.
 *
 * An EVENT is a fact ("job X appeared"). Its dedupe key identifies that fact, so the same fact can
 * be reported any number of times (a retried check, two workers, a re-run) and still create one
 * notification per recipient. A CHANNEL delivers a notification somewhere (in-app today, email
 * later); the worker stores in-app notifications itself and hands the rest to channels.
 */
export const NOTIFICATION_TYPES = [
  'NEW_JOB',
  'JOB_CLOSED',
  'JOB_CHANGED',
  'WEBSITE_CHANGED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface JobRef {
  jobId: string;
  companyId: string;
  companyName: string;
  title: string;
  location: string | null;
}

export type NotificationEvent =
  | ({ type: 'NEW_JOB'; applicationUrl: string | null } & JobRef)
  | ({ type: 'JOB_CLOSED'; closedAt: Date; reason: string } & JobRef)
  | ({ type: 'JOB_CHANGED'; fields: string[]; contentHash: string } & JobRef)
  | {
      type: 'WEBSITE_CHANGED';
      companyId: string;
      companyName: string;
      reason: 'DOMAIN_CHANGED' | 'UNAVAILABLE';
      /** DOMAIN_CHANGED: the old and the new domain. */
      from?: string;
      to?: string;
      /** UNAVAILABLE: when the run of failures began (identifies this outage). */
      since?: Date;
      failures?: number;
    };

/**
 * The identity of the fact:
 *  - a job is "new" once, however often it is seen;
 *  - a job closes (or reopens and closes again) at a particular moment;
 *  - a change is identified by the content it produced;
 *  - an outage by when it began, a move by where the site went.
 */
export function dedupeKey(event: NotificationEvent): string {
  switch (event.type) {
    case 'NEW_JOB':
      return `job-new:${event.jobId}`;
    case 'JOB_CLOSED':
      return `job-closed:${event.jobId}:${event.closedAt.getTime()}`;
    case 'JOB_CHANGED':
      return `job-changed:${event.jobId}:${event.contentHash}`;
    case 'WEBSITE_CHANGED':
      return event.reason === 'DOMAIN_CHANGED'
        ? `website-moved:${event.companyId}:${event.to ?? 'unknown'}`
        : `website-down:${event.companyId}:${event.since?.getTime() ?? 0}`;
  }
}

export interface RenderedNotification {
  type: NotificationType;
  title: string;
  body: string;
  /** Ids for deep links. Plain data: the UI builds the links, nothing here is markup. */
  data: Record<string, string | number | boolean | null | string[]>;
}

/** Plain text only (scraped titles are untrusted, so nothing is interpreted as markup). */
const clean = (value: string, max = 160) =>
  value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const at = (job: JobRef) => (job.location ? ` (${clean(job.location, 60)})` : '');

export function renderNotification(event: NotificationEvent): RenderedNotification {
  switch (event.type) {
    case 'NEW_JOB':
      return {
        type: event.type,
        title: `New job at ${clean(event.companyName, 80)}`,
        body: `${clean(event.title)}${at(event)}`,
        data: {
          companyId: event.companyId,
          jobId: event.jobId,
          applicationUrl: event.applicationUrl,
        },
      };
    case 'JOB_CLOSED':
      return {
        type: event.type,
        title: `Job closed at ${clean(event.companyName, 80)}`,
        body: `${clean(event.title)}${at(event)} — ${clean(event.reason, 120)}`,
        data: { companyId: event.companyId, jobId: event.jobId },
      };
    case 'JOB_CHANGED':
      return {
        type: event.type,
        title: `Job updated at ${clean(event.companyName, 80)}`,
        body: `${clean(event.title)}${at(event)} — changed: ${event.fields.join(', ')}`,
        data: { companyId: event.companyId, jobId: event.jobId, fields: event.fields },
      };
    case 'WEBSITE_CHANGED':
      return {
        type: event.type,
        title:
          event.reason === 'DOMAIN_CHANGED'
            ? `${clean(event.companyName, 80)} website moved`
            : `${clean(event.companyName, 80)} website is unavailable`,
        body:
          event.reason === 'DOMAIN_CHANGED'
            ? `The website now redirects from ${clean(event.from ?? 'its old domain', 80)} to ${clean(event.to ?? 'another domain', 80)}.`
            : `The website could not be reached in ${event.failures ?? 'several'} consecutive checks. Jobs are unaffected.`,
        data: { companyId: event.companyId, reason: event.reason },
      };
  }
}

// ---------------------------------------------------------------- channels

export type ChannelId = 'in_app' | 'email';

export interface Recipient {
  userId: string;
  email: string;
}

export interface DeliverableNotification {
  id: string;
  workspaceId: string;
  type: NotificationType;
  title: string;
  body: string;
  data: RenderedNotification['data'];
}

/**
 * Where a notification can be delivered. In-app notifications are rows the UI reads, so the
 * worker stores them directly; every other channel (email now a stub, later push or chat)
 * implements this interface and is registered in the worker.
 */
export interface NotificationChannel {
  readonly id: Exclude<ChannelId, 'in_app'>;
  /** False when the channel is not set up: it is skipped, never an error. */
  readonly configured: boolean;
  deliver(notification: DeliverableNotification, recipient: Recipient): Promise<void>;
}

/** The email channel until a mail provider is configured: nothing is sent. */
export class UnconfiguredEmailChannel implements NotificationChannel {
  readonly id = 'email' as const;
  readonly configured = false;
  async deliver(): Promise<void> {
    throw new Error('Email delivery is not configured');
  }
}

/** Which recipients want which type on which channel; no stored preference means the defaults. */
export const DEFAULT_CHANNEL_PREFERENCE: Record<ChannelId, boolean> = {
  in_app: true,
  email: false,
};

export function wants(
  preference: { inApp: boolean; email: boolean } | undefined,
  channel: ChannelId,
): boolean {
  if (!preference) return DEFAULT_CHANNEL_PREFERENCE[channel];
  return channel === 'in_app' ? preference.inApp : preference.email;
}
