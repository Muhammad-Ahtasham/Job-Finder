/** Queue + Redis key names shared by the API (producer) and worker (consumer). */
export const QUEUES = {
  MAINTENANCE: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const MAINTENANCE_JOBS = {
  PURGE_EXPIRED_SESSIONS: 'purge-expired-sessions',
} as const;

export const WORKER_HEARTBEAT_KEY = 'jf:worker:heartbeat';
