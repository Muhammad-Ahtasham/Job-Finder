import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import {
  DISCOVERY_JOBS,
  providerQueueName,
  taskJobId,
  type ExecuteTaskJob,
} from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';
import { REDIS } from '../infrastructure.module';
import { ProviderRegistry } from './provider-registry';
import { ensureJob } from './queue-utils';
import { backoffDelay, PROVIDER_BACKOFF } from './retry-policy';
import { DiscoveryTaskRunner } from './task-runner';

/**
 * One BullMQ queue + worker PER PROVIDER. That is how provider-specific rate limits are
 * enforced: each worker carries its provider's limiter (shared across all worker processes
 * through Redis) and concurrency, so a slow/limited provider never starves another.
 */
@Injectable()
export class ProviderQueuesService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProviderQueuesService.name);
  private readonly queues = new Map<string, Queue<ExecuteTaskJob>>();
  private readonly workers = new Map<string, Worker<ExecuteTaskJob>>();
  private startPromise?: Promise<void>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly registry: ProviderRegistry,
    private readonly runner: DiscoveryTaskRunner,
  ) {}

  onApplicationBootstrap(): Promise<void> {
    return this.start();
  }

  /**
   * Memoized so other services can `await start()` — Nest runs bootstrap hooks concurrently,
   * and planning must never begin before every provider queue exists (tasks would look orphaned).
   */
  start(): Promise<void> {
    this.startPromise ??= this.createQueuesAndWorkers();
    return this.startPromise;
  }

  private async createQueuesAndWorkers(): Promise<void> {
    for (const provider of this.registry.providers) {
      const name = providerQueueName(provider.id);
      const queue = new Queue<ExecuteTaskJob>(name, { connection: this.redis.duplicate() });
      const worker: Worker<ExecuteTaskJob> = new Worker<ExecuteTaskJob>(
        name,
        (job) => this.runner.run(job, worker as Worker),
        {
          connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
          concurrency: provider.rateLimit.concurrency,
          limiter: { max: provider.rateLimit.maxRequests, duration: provider.rateLimit.perMs },
          settings: {
            backoffStrategy: (attemptsMade, type, error) =>
              type === PROVIDER_BACKOFF
                ? backoffDelay(attemptsMade, this.env.DISCOVERY_RETRY_BASE_MS, error)
                : this.env.DISCOVERY_RETRY_BASE_MS,
          },
        },
      );
      worker.on('error', (error) => this.logger.warn(`${name}: ${error.message}`));
      await worker.waitUntilReady();
      this.queues.set(provider.id, queue);
      this.workers.set(provider.id, worker);
      this.logger.log(
        `Provider "${provider.id}" ready: ${provider.rateLimit.maxRequests} req/${provider.rateLimit.perMs}ms, concurrency ${provider.rateLimit.concurrency}`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }

  hasProvider(providerId: string): boolean {
    return this.queues.has(providerId);
  }

  /** Idempotent: deterministic job id + replacement of finished jobs (see ensureJob). */
  async ensureTaskJob(
    providerId: string,
    taskId: string,
    maxAttempts: number,
  ): Promise<'exists' | 'added' | 'no-provider'> {
    const queue = this.queues.get(providerId);
    if (!queue) return 'no-provider';
    return ensureJob(
      queue as Queue,
      DISCOVERY_JOBS.EXECUTE_TASK,
      { taskId } satisfies ExecuteTaskJob,
      {
        jobId: taskJobId(taskId),
        attempts: maxAttempts,
        backoff: { type: PROVIDER_BACKOFF, delay: this.env.DISCOVERY_RETRY_BASE_MS },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86_400 },
      },
    );
  }
}
