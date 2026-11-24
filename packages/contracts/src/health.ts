import { z } from 'zod';

export const dependencyStatusSchema = z.object({
  status: z.enum(['up', 'down', 'unknown']),
  latencyMs: z.number().optional(),
  detail: z.string().optional(),
});
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

export const liveResponseSchema = z.object({ status: z.literal('ok') });
export type LiveResponse = z.infer<typeof liveResponseSchema>;

export const readyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  checks: z.object({
    database: dependencyStatusSchema,
    redis: dependencyStatusSchema,
    /** Informational: the worker being down degrades but does not fail readiness. */
    worker: dependencyStatusSchema,
  }),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;

/** Payload the worker writes to Redis under WORKER_HEARTBEAT_KEY. */
export const workerHeartbeatSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
  at: z.string(),
});
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;
