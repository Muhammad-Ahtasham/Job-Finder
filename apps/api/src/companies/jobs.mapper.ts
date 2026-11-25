import type {
  Job as JobRow,
  JobCheck as CheckRow,
  JobRun as RunRow,
  JobSource as SourceRow,
} from '@jobfinder/database';
import {
  extractionErrorSchema,
  type Job,
  type JobCheck,
  type JobRun,
  type JobSource,
} from '@jobfinder/contracts';
import { z } from 'zod';

const errorList = z.array(extractionErrorSchema);
const iso = (d: Date | null) => d?.toISOString() ?? null;

export function toJob(job: JobRow & { source: { providerId: string } }): Job {
  return {
    id: job.id,
    sourceId: job.sourceId,
    providerId: job.source.providerId,
    externalId: job.externalId,
    title: job.title,
    description: job.description,
    location: job.location,
    locations: job.locations,
    department: job.department,
    employmentType: job.employmentType,
    workplaceType: job.workplaceType,
    applicationUrl: job.applicationUrl,
    sourceUrl: job.sourceUrl,
    publishedAt: iso(job.publishedAt),
    extraction: job.extraction,
    status: job.status,
    firstSeenAt: job.firstSeenAt.toISOString(),
    lastSeenAt: job.lastSeenAt.toISOString(),
    closedAt: iso(job.closedAt),
  };
}

export function toJobCheck(check: CheckRow): JobCheck {
  return {
    id: check.id,
    outcome: check.outcome,
    authoritative: check.authoritative,
    jobsFound: check.jobsFound,
    jobsCreated: check.jobsCreated,
    jobsUpdated: check.jobsUpdated,
    jobsClosed: check.jobsClosed,
    duplicatesSkipped: check.duplicatesSkipped,
    pagesFetched: check.pagesFetched,
    errorCode: check.errorCode,
    errorMessage: check.errorMessage,
    retryable: check.retryable,
    httpStatus: check.httpStatus,
    evidence: check.evidence,
    startedAt: check.startedAt.toISOString(),
    finishedAt: iso(check.finishedAt),
  };
}

export function toJobSource(source: SourceRow, openJobs: number, checks: CheckRow[]): JobSource {
  return {
    id: source.id,
    providerId: source.providerId,
    boardKey: source.boardKey,
    boardUrl: source.boardUrl,
    status: source.status,
    discoveredFromUrl: source.discoveredFromUrl,
    discoveryConfidence: source.discoveryConfidence,
    discoveryEvidence: source.discoveryEvidence,
    lastCheckedAt: iso(source.lastCheckedAt),
    lastSuccessAt: iso(source.lastSuccessAt),
    lastOutcome: source.lastOutcome,
    consecutiveFailures: source.consecutiveFailures,
    openJobs,
    latestChecks: checks.map(toJobCheck),
  };
}

export function toJobRun(run: RunRow): JobRun {
  const stats = z.record(z.string(), z.number()).safeParse(run.stats);
  const errors = errorList.safeParse(run.errors);
  return {
    id: run.id,
    companyId: run.companyId,
    status: run.status,
    attempts: run.attempts,
    careerPagesFound: run.careerPagesFound,
    sourcesChecked: run.sourcesChecked,
    jobsFound: run.jobsFound,
    stats: stats.success ? stats.data : {},
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    errors: errors.success ? errors.data : [],
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
  };
}
