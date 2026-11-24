import type { SearchRun, TaskStatus } from '@jobfinder/database';
import type { Run, TaskCounts } from '@jobfinder/contracts';

/** Shape of SearchRun.config as written by the API and completed by the worker's planner. */
export interface RunConfig {
  country: string;
  city: string;
  industry: string;
  keywords: string[];
  providers?: { id: string; displayName: string; attribution: string | null }[];
  skippedProviders?: { id: string; reason: string }[];
  planError?: string;
}

export const emptyTaskCounts = (): TaskCounts => ({
  total: 0,
  queued: 0,
  running: 0,
  retrying: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
});

const STATUS_KEY: Record<TaskStatus, Exclude<keyof TaskCounts, 'total'>> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  RETRYING: 'retrying',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export function addToCounts(counts: TaskCounts, status: TaskStatus, n: number): void {
  counts[STATUS_KEY[status]] += n;
  counts.total += n;
}

export function toRun(run: SearchRun, tasks: TaskCounts): Run {
  const config = run.config as unknown as RunConfig;
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    cancelRequested: run.cancelRequestedAt !== null,
    providers: (config.providers ?? []).map((p) => p.id),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    stats: {
      candidatesFound: run.candidatesFound,
      candidatesFiltered: run.candidatesFiltered,
      companiesCreated: run.companiesCreated,
      companiesMatched: run.companiesMatched,
      reviewsCreated: run.reviewsCreated,
      duplicatesSkipped: run.duplicatesSkipped,
      rejected: run.rejected,
    },
    tasks,
  };
}
