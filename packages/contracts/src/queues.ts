import { z } from 'zod';

/**
 * Queue + Redis key names shared by the API (producer) and worker (consumer).
 * NOTE: BullMQ job ids must not contain ":" — use "-".
 */
export const QUEUES = {
  MAINTENANCE: 'maintenance',
  /** Plans a run into provider tasks. */
  DISCOVERY_RUNS: 'discovery-runs',
  /** Website enrichment: one job per ExtractionRun. */
  ENRICHMENT: 'company-enrichment',
  /** Career page discovery + job fetching: one job per JobRun. */
  JOB_DISCOVERY: 'job-discovery',
  /** Scores a project's jobs: one job per project. */
  JOB_MATCHING: 'job-matching',
  /** CSV/XLSX generation: one job per Export. */
  EXPORTS: 'exports',
  /** Scheduled checks of job sources and company websites: one job per due schedule. */
  MONITORING: 'monitoring',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** One queue per provider so each gets its own rate limiter and concurrency. */
export const providerQueueName = (providerId: string) => `discovery.${providerId}`;

export const MAINTENANCE_JOBS = {
  PURGE_EXPIRED_SESSIONS: 'purge-expired-sessions',
  RECONCILE_DISCOVERY: 'reconcile-discovery',
  PURGE_EXPIRED_SOURCE_DATA: 'purge-expired-source-data',
  RECONCILE_ENRICHMENT: 'reconcile-enrichment',
  RECONCILE_JOBS: 'reconcile-jobs',
  /** Status sweep (expiry / stale), pending job analysis. */
  SWEEP_INTELLIGENCE: 'sweep-intelligence',
  /** Re-enqueue lost exports; delete files past their retention. */
  RECONCILE_EXPORTS: 'reconcile-exports',
  /** Finds due monitoring schedules and queues them. */
  MONITORING_TICK: 'monitoring-tick',
} as const;

export const MONITORING_JOBS = {
  RUN_SCHEDULE: 'run-schedule',
} as const;

export const runScheduleJobSchema = z.object({ scheduleId: z.string().uuid() });
export type RunScheduleJob = z.infer<typeof runScheduleJobSchema>;
export const monitoringJobId = (scheduleId: string) => `monitor-${scheduleId}`;

export const EXPORT_JOBS = {
  GENERATE: 'generate-export',
} as const;

export const generateExportJobSchema = z.object({ exportId: z.string().uuid() });
export type GenerateExportJob = z.infer<typeof generateExportJobSchema>;
export const exportJobId = (exportId: string) => `export-${exportId}`;

export const DISCOVERY_JOBS = {
  PLAN_RUN: 'plan-run',
  EXECUTE_TASK: 'execute-task',
} as const;

export const ENRICHMENT_JOBS = {
  ENRICH_COMPANY: 'enrich-company',
} as const;

export const enrichCompanyJobSchema = z.object({ runId: z.string().uuid() });
export type EnrichCompanyJob = z.infer<typeof enrichCompanyJobSchema>;
export const enrichJobId = (runId: string) => `enrich-${runId}`;

export const JOB_DISCOVERY_JOBS = {
  DISCOVER_JOBS: 'discover-jobs',
} as const;

export const discoverJobsJobSchema = z.object({ runId: z.string().uuid() });
export type DiscoverJobsJob = z.infer<typeof discoverJobsJobSchema>;
export const jobRunJobId = (runId: string) => `jobs-${runId}`;

export const JOB_MATCHING_JOBS = {
  MATCH_PROJECT: 'match-project',
} as const;

export const matchProjectJobSchema = z.object({ projectId: z.string().uuid() });
export type MatchProjectJob = z.infer<typeof matchProjectJobSchema>;
export const matchProjectJobId = (projectId: string) => `match-${projectId}`;

export const planRunJobSchema = z.object({ runId: z.string().uuid() });
export type PlanRunJob = z.infer<typeof planRunJobSchema>;

export const executeTaskJobSchema = z.object({ taskId: z.string().uuid() });
export type ExecuteTaskJob = z.infer<typeof executeTaskJobSchema>;

/** Deterministic job ids make enqueueing idempotent. */
export const planJobId = (runId: string) => `plan-${runId}`;
export const taskJobId = (taskId: string) => `task-${taskId}`;

export const WORKER_HEARTBEAT_KEY = 'jf:worker:heartbeat';
