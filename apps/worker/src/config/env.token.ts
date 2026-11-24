import type { WorkerEnv } from '@jobfinder/config';

export const ENV = Symbol('WORKER_ENV');
export type Env = WorkerEnv;
