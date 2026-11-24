import type { JobsOptions, Queue } from 'bullmq';

/**
 * Idempotent enqueue. BullMQ ignores `add` when a job with the same id still exists —
 * including completed/failed ones — which would silently strand a task whose database row
 * says it still needs work. So: keep live jobs, replace finished ones, add if missing.
 */
export async function ensureJob(
  queue: Queue,
  name: string,
  data: object,
  options: JobsOptions & { jobId: string },
): Promise<'exists' | 'added'> {
  const existing = await queue.getJob(options.jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'completed' && state !== 'failed') return 'exists';
    await existing.remove().catch(() => undefined);
  }
  await queue.add(name, data, options);
  return 'added';
}
