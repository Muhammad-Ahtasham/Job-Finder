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
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** One queue per provider so each gets its own rate limiter and concurrency. */
export const providerQueueName = (providerId: string) => `discovery.${providerId}`;

export const MAINTENANCE_JOBS = {
  PURGE_EXPIRED_SESSIONS: 'purge-expired-sessions',
  RECONCILE_DISCOVERY: 'reconcile-discovery',
  PURGE_EXPIRED_SOURCE_DATA: 'purge-expired-source-data',
  RECONCILE_ENRICHMENT: 'reconcile-enrichment',
} as const;

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

export const planRunJobSchema = z.object({ runId: z.string().uuid() });
export type PlanRunJob = z.infer<typeof planRunJobSchema>;

export const executeTaskJobSchema = z.object({ taskId: z.string().uuid() });
export type ExecuteTaskJob = z.infer<typeof executeTaskJobSchema>;

/** Deterministic job ids make enqueueing idempotent. */
export const planJobId = (runId: string) => `plan-${runId}`;
export const taskJobId = (taskId: string) => `task-${taskId}`;

export const WORKER_HEARTBEAT_KEY = 'jf:worker:heartbeat';
