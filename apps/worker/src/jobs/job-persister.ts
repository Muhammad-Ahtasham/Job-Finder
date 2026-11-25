import type { Job, JobSource, Prisma, PrismaClient } from '@jobfinder/database';
import {
  jobContentHash,
  nextJobStatus,
  validateExpiresAt,
  validateHttpUrl,
  validatePublishedAt,
  type JobStatusValue,
} from '@jobfinder/intelligence';
import { jobFingerprint, type JobFetchResult, type NormalizedJob } from '@jobfinder/jobs';
import {
  DEFAULT_MISS_POLICY,
  registerMiss,
  type MissPolicy,
  type NotificationEvent,
} from '@jobfinder/monitoring';

export interface CheckSummary {
  checkId: string;
  outcome: JobFetchResult['outcome'];
  jobsFound: number;
  jobsCreated: number;
  jobsUpdated: number;
  jobsClosed: number;
  duplicatesSkipped: number;
  /** Jobs an authoritative answer did not list. */
  jobsMissing: number;
  /** Of those, how many wait for a confirming check before they are closed. */
  pendingConfirmation: number;
  retryable: boolean;
  errorCode?: string;
}

/** What changing means "material" for a job: worth a notification, not just a history entry. */
const MATERIAL = ['title', 'location', 'employmentType', 'workplaceType', 'applicationUrl'];

export interface PersistOptions {
  trigger?: 'MANUAL' | 'SCHEDULED';
  scheduleId?: string | null;
  /** How many separate checks must miss a job before it is closed. */
  missPolicy?: MissPolicy;
  /**
   * Called inside the same transaction with the events this check produced, so a job and its
   * notification are committed together or not at all. Events are idempotent by dedupe key.
   */
  notify?: (tx: Prisma.TransactionClient, events: NotificationEvent[]) => Promise<void>;
}

interface JobFact {
  id: string;
  title: string;
  location: string | null;
}

/** Providers whose lists are complete and official. A job they carry supersedes a scraped copy. */
const isScraped = (providerId: string) => providerId === 'generic-html';

type Observation = Prisma.JobObservationCreateManyInput;
type Change = { from: unknown; to: unknown };

/** Fields whose change is worth a CHANGED observation (the description is tracked by its hash). */
const TRACKED = [
  'title',
  'location',
  'department',
  'employmentType',
  'workplaceType',
  'applicationUrl',
  'publishedAt',
  'expiresAt',
] as const;

const asComparable = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

function diff(
  prior: Job,
  next: Record<string, unknown>,
  contentChanged: boolean,
): Record<string, Change> {
  const changes: Record<string, Change> = {};
  for (const key of TRACKED) {
    const before = asComparable((prior as unknown as Record<string, unknown>)[key]);
    const after = asComparable(next[key]);
    if (before !== after) changes[key] = { from: before ?? null, to: after ?? null };
  }
  if (prior.description !== next.description)
    changes.description = { from: 'changed', to: 'changed' };
  if (contentChanged && Object.keys(changes).length === 0)
    changes.content = { from: 'changed', to: 'changed' };
  return changes;
}

/**
 * Writes one source check: the JobCheck row, the jobs it saw, closures, the observation history
 * and the source's health — atomically. Key rules:
 *  - jobs are unique per (source, externalId), so re-running a check never duplicates;
 *  - a job already carried by an official ATS source is not re-imported from a scraped page
 *    (same title + place), and an ATS job closes a previously scraped twin;
 *  - jobs are closed ONLY by an authoritative, successful answer, and only when SEVERAL
 *    separate checks have missed them (or the source itself reports the closure). A failed or
 *    inconclusive check, or a partial page, changes no job's status and records no "missing"
 *    observation; a single missing sighting only starts the count;
 *  - a first-ever check of a source is a baseline: its jobs are recorded but not announced;
 *  - published URLs and dates are validated here, deterministically; an invalid one is dropped
 *    (never repaired or guessed);
 *  - every sighting, change and status change is appended to `job_observations`.
 */
export async function persistCheck(
  prisma: PrismaClient,
  source: JobSource,
  runId: string | null,
  result: JobFetchResult,
  startedAt: Date,
  options: PersistOptions = {},
): Promise<CheckSummary> {
  const now = new Date();
  const policy = options.missPolicy ?? DEFAULT_MISS_POLICY;
  /** The source had never answered before: everything it lists is "already there", not news. */
  const baseline = source.lastSuccessAt === null;
  const jobs: NormalizedJob[] =
    result.outcome === 'JOBS' || result.outcome === 'FAILED' ? result.jobs : [];
  const authoritative =
    (result.outcome === 'JOBS' || result.outcome === 'NO_OPENINGS') && result.authoritative;
  const answered = result.outcome === 'JOBS' || result.outcome === 'NO_OPENINGS';

  return prisma.$transaction(async (tx) => {
    const check = await tx.jobCheck.create({
      data: {
        workspaceId: source.workspaceId,
        companyId: source.companyId,
        sourceId: source.id,
        runId,
        trigger: options.trigger ?? 'MANUAL',
        scheduleId: options.scheduleId ?? null,
        outcome: result.outcome,
        authoritative,
        pagesFetched: result.pagesFetched,
        errorCode: result.outcome === 'FAILED' ? result.error.code : null,
        errorMessage: result.outcome === 'FAILED' ? result.error.message.slice(0, 500) : null,
        retryable: result.outcome === 'FAILED' ? result.error.retryable : null,
        httpStatus: result.outcome === 'FAILED' ? (result.error.httpStatus ?? null) : null,
        evidence:
          result.outcome === 'NO_OPENINGS'
            ? result.evidence
            : result.outcome === 'INCONCLUSIVE'
              ? result.reason
              : null,
        startedAt,
      },
    });

    const observations: Observation[] = [];
    const observe = (o: Omit<Observation, 'workspaceId' | 'checkId' | 'observedAt'>) =>
      observations.push({
        ...o,
        workspaceId: source.workspaceId,
        checkId: check.id,
        observedAt: now,
      });

    let created = 0;
    let updated = 0;
    let duplicates = 0;
    const newJobs: (JobFact & { applicationUrl: string | null })[] = [];
    const closedJobs: (JobFact & { reason: string })[] = [];
    const changedJobs: (JobFact & { fields: string[]; contentHash: string })[] = [];

    const existing = await tx.job.findMany({ where: { sourceId: source.id } });
    const byExternal = new Map(existing.map((j) => [j.externalId, j]));

    if (jobs.length > 0) {
      // Same vacancy already provided by another source of this company?
      const otherOpen = await tx.job.findMany({
        where: { companyId: source.companyId, status: 'OPEN', sourceId: { not: source.id } },
        select: {
          id: true,
          fingerprint: true,
          sourceId: true,
          source: { select: { providerId: true } },
        },
      });

      for (const job of jobs) {
        const fingerprint = jobFingerprint(job.title, job.location);
        const publishedAt = validatePublishedAt(job.publishedAt, now);
        const expiresAt = validateExpiresAt(job.expiresAt, publishedAt, now);
        const contentHash = jobContentHash({
          title: job.title,
          description: job.description,
          location: job.location,
          locations: job.locations,
          department: job.department,
          employmentType: job.employmentType,
          workplaceType: job.workplaceType,
        });
        const data = {
          fingerprint,
          title: job.title,
          description: job.description,
          location: job.location,
          locations: job.locations,
          department: job.department,
          employmentType: job.employmentType,
          workplaceType: job.workplaceType,
          // Exactly as published — or nothing, if it is not a plain public http(s) URL.
          applicationUrl: validateHttpUrl(job.applicationUrl),
          sourceUrl: job.sourceUrl,
          publishedAt,
          expiresAt,
          extraction: job.extraction,
          contentHash,
        };
        const prior = byExternal.get(job.externalId);
        // A posting the source already marks closed and that we never saw open is not imported.
        if (!prior && job.explicitlyClosed) continue;
        const twins = otherOpen.filter((o) => o.fingerprint === fingerprint);
        const officialTwin =
          isScraped(source.providerId) && twins.some((t) => !isScraped(t.source.providerId));

        if (prior && officialTwin) {
          // An official source carries this vacancy: a scraped copy must not be (re)opened.
          const change = nextJobStatus(prior.status as JobStatusValue, {
            type: 'SUPERSEDED_BY_OFFICIAL_SOURCE',
          });
          if (change) {
            await tx.job.update({
              where: { id: prior.id },
              data: {
                status: change.status,
                closedAt: now,
                statusReason: change.reason,
                statusChangedAt: now,
              },
            });
            observe({
              jobId: prior.id,
              kind: 'STATUS_CHANGED',
              fromStatus: prior.status,
              toStatus: change.status,
              reason: change.reason,
              contentHash,
            });
            duplicates += 1;
          }
          continue;
        }

        if (prior) {
          const contentChanged = prior.contentHash !== contentHash;
          const changes = diff(prior, data, contentChanged && prior.contentHash !== '');
          // The source itself saying "closed" closes at once; otherwise a sighting (re)opens it.
          const change = job.explicitlyClosed
            ? nextJobStatus(prior.status as JobStatusValue, { type: 'SOURCE_REPORTED_CLOSED' })
            : nextJobStatus(prior.status as JobStatusValue, { type: 'SEEN', now, expiresAt });
          const status = change?.status ?? (prior.status as JobStatusValue);
          await tx.job.update({
            where: { id: prior.id },
            data: {
              ...data,
              status,
              closedAt:
                status === 'CLOSED' || status === 'EXPIRED' ? (prior.closedAt ?? now) : null,
              lastSeenAt: now,
              lastCheckId: check.id,
              // Changed content invalidates the stored analysis; the intelligence sweep redoes it.
              ...(contentChanged ? { analysisHash: null } : {}),
              // Listed again: whatever "missing" count it had is void.
              ...(prior.missedChecks > 0
                ? { missedChecks: 0, firstMissedAt: null, lastMissedCheckId: null }
                : {}),
              ...(change ? { statusReason: change.reason || null, statusChangedAt: now } : {}),
            },
          });
          const hasChanges = Object.keys(changes).length > 0;
          const materialFields = Object.keys(changes).filter((k) => MATERIAL.includes(k));
          observe({
            jobId: prior.id,
            kind: hasChanges ? 'CHANGED' : 'SEEN',
            changes: changes as Prisma.InputJsonValue,
            reason:
              materialFields.length > 0 ? `material change: ${materialFields.join(', ')}` : null,
            contentHash,
          });
          const fact = { id: prior.id, title: data.title, location: data.location };
          if (materialFields.length > 0 && prior.status === 'OPEN' && status === 'OPEN') {
            changedJobs.push({ ...fact, fields: materialFields, contentHash });
          }
          if (change?.status === 'CLOSED') closedJobs.push({ ...fact, reason: change.reason });
          if (change) {
            observe({
              jobId: prior.id,
              kind: 'STATUS_CHANGED',
              fromStatus: prior.status,
              toStatus: change.status,
              reason: change.reason || null,
              contentHash,
            });
          }
          if (hasChanges || change) updated += 1;
          continue;
        }

        if (officialTwin) {
          duplicates += 1; // an official source already has it
          continue;
        }
        const status: JobStatusValue =
          nextJobStatus('OPEN', { type: 'SEEN', now, expiresAt })?.status ?? 'OPEN';
        const createdJob = await tx.job.create({
          data: {
            workspaceId: source.workspaceId,
            companyId: source.companyId,
            sourceId: source.id,
            externalId: job.externalId,
            firstSeenAt: now,
            lastSeenAt: now,
            lastCheckId: check.id,
            status,
            closedAt: status === 'EXPIRED' ? now : null,
            statusChangedAt: now,
            statusReason: status === 'EXPIRED' ? 'published expiry date passed' : null,
            ...data,
          },
        });
        observe({
          jobId: createdJob.id,
          kind: 'FIRST_SEEN',
          toStatus: status,
          contentHash,
        });
        created += 1;
        if (status === 'OPEN') {
          newJobs.push({
            id: createdJob.id,
            title: data.title,
            location: data.location,
            applicationUrl: data.applicationUrl,
          });
        }
        if (!isScraped(source.providerId)) {
          // The official copy supersedes any scraped twin.
          const scrapedTwins = twins.filter((t) => isScraped(t.source.providerId)).map((t) => t.id);
          if (scrapedTwins.length > 0) {
            await tx.job.updateMany({
              where: { id: { in: scrapedTwins } },
              data: {
                status: 'CLOSED',
                closedAt: now,
                statusChangedAt: now,
                statusReason: 'replaced by the same vacancy from an official job board',
              },
            });
            for (const id of scrapedTwins) {
              observe({
                jobId: id,
                kind: 'STATUS_CHANGED',
                fromStatus: 'OPEN',
                toStatus: 'CLOSED',
                reason: 'replaced by the same vacancy from an official job board',
              });
            }
            duplicates += scrapedTwins.length;
          }
        }
      }
    }

    // ---- jobs this source did not list. Only an answered check says anything about them, and
    // even an authoritative one only STARTS the count: closure needs confirming checks.
    let closed = 0;
    let missing = 0;
    let pending = 0;
    if (answered) {
      const listed = new Set(jobs.map((j) => j.externalId));
      const absent = existing.filter(
        (j) => !listed.has(j.externalId) && (j.status === 'OPEN' || j.status === 'UNKNOWN'),
      );
      for (const job of absent) {
        if (!authoritative) {
          observe({
            jobId: job.id,
            kind: 'MISSING',
            reason: 'not listed, but the source is not authoritative: status unchanged',
          });
          continue;
        }
        missing += 1;
        const miss = registerMiss(
          {
            missedChecks: job.missedChecks,
            firstMissedAt: job.firstMissedAt,
            lastMissedCheckId: job.lastMissedCheckId,
          },
          check.id,
          now,
          policy,
        );
        const change = nextJobStatus(job.status as JobStatusValue, {
          type: 'MISSING_FROM_AUTHORITATIVE_ANSWER',
          missedChecks: miss.missedChecks,
          required: policy.confirmations,
        });
        await tx.job.update({
          where: { id: job.id },
          data: {
            missedChecks: miss.missedChecks,
            firstMissedAt: miss.firstMissedAt,
            lastMissedCheckId: miss.lastMissedCheckId,
            ...(change
              ? {
                  status: change.status,
                  closedAt: now,
                  statusReason: change.reason,
                  statusChangedAt: now,
                }
              : {}),
          },
        });
        observe({
          jobId: job.id,
          kind: 'MISSING',
          reason: change
            ? change.reason
            : `not listed by an authoritative source (${miss.missedChecks} of ${policy.confirmations}); waiting for a confirming check`,
        });
        if (change) {
          closed += 1;
          closedJobs.push({
            id: job.id,
            title: job.title,
            location: job.location,
            reason: change.reason,
          });
          observe({
            jobId: job.id,
            kind: 'STATUS_CHANGED',
            fromStatus: job.status,
            toStatus: change.status,
            reason: change.reason,
          });
        } else {
          pending += 1;
        }
      }
    }

    if (observations.length > 0) await tx.jobObservation.createMany({ data: observations });

    await tx.jobSource.update({
      where: { id: source.id },
      data: {
        lastCheckedAt: now,
        lastOutcome: result.outcome,
        ...(answered ? { lastSuccessAt: now, consecutiveFailures: 0 } : {}),
        ...(result.outcome === 'FAILED' ? { consecutiveFailures: { increment: 1 } } : {}),
      },
    });
    await tx.jobCheck.update({
      where: { id: check.id },
      data: {
        jobsFound: jobs.length,
        jobsCreated: created,
        jobsUpdated: updated,
        jobsClosed: closed,
        duplicatesSkipped: duplicates,
        jobsMissing: missing,
        pendingConfirmation: pending,
        finishedAt: now,
      },
    });
    if (authoritative) {
      await tx.company.updateMany({
        where: { id: source.companyId, careersStatus: { not: 'VERIFIED' } },
        data: { careersStatus: 'VERIFIED' },
      });
    }

    // Announce what this check found, in the same transaction. The first check of a source only
    // records its jobs; a closure or a change is news at any time.
    if (options.notify) {
      const events: NotificationEvent[] = [];
      if (newJobs.length + closedJobs.length + changedJobs.length > 0) {
        const company = await tx.company.findUnique({
          where: { id: source.companyId },
          select: { displayName: true },
        });
        const ref = (j: JobFact) => ({
          jobId: j.id,
          companyId: source.companyId,
          companyName: company?.displayName ?? 'A company',
          title: j.title,
          location: j.location,
        });
        if (!baseline) {
          for (const j of newJobs) {
            events.push({ type: 'NEW_JOB', applicationUrl: j.applicationUrl, ...ref(j) });
          }
        }
        for (const j of closedJobs) {
          events.push({ type: 'JOB_CLOSED', closedAt: now, reason: j.reason, ...ref(j) });
        }
        for (const j of changedJobs) {
          events.push({
            type: 'JOB_CHANGED',
            fields: j.fields,
            contentHash: j.contentHash,
            ...ref(j),
          });
        }
      }
      if (events.length > 0) await options.notify(tx, events);
    }

    return {
      checkId: check.id,
      outcome: result.outcome,
      jobsFound: jobs.length,
      jobsCreated: created,
      jobsUpdated: updated,
      jobsClosed: closed,
      duplicatesSkipped: duplicates,
      jobsMissing: missing,
      pendingConfirmation: pending,
      retryable: result.outcome === 'FAILED' && result.error.retryable,
      errorCode: result.outcome === 'FAILED' ? result.error.code : undefined,
    };
  });
}
