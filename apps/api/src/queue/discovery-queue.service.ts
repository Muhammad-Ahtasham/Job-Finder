import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DISCOVERY_JOBS, planJobId, QUEUES, type PlanRunJob } from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';

/**
 * Producer side of discovery. The API only enqueues a "plan" job per run; the worker (which
 * knows the configured providers) expands it into provider tasks. Enqueueing is best-effort:
 * the run row is the source of truth and the worker's reconciler re-enqueues any run whose
 * plan job was lost.
 */
@Injectable()
export class DiscoveryQueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(DiscoveryQueueService.name);
  private readonly connection: Redis;
  private readonly runs: Queue<PlanRunJob>;

  constructor(@Inject(ENV) env: Env) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (error) => this.logger.warn(`Queue Redis error: ${error.message}`));
    this.runs = new Queue<PlanRunJob>(QUEUES.DISCOVERY_RUNS, { connection: this.connection });
  }

  /** Idempotent: the deterministic job id means a repeated call cannot create a second plan. */
  async enqueuePlan(runId: string): Promise<boolean> {
    try {
      await this.runs.add(
        DISCOVERY_JOBS.PLAN_RUN,
        { runId },
        {
          jobId: planJobId(runId),
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86_400 },
        },
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not enqueue plan for run ${runId}; the reconciler will retry: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runs.close();
    this.connection.disconnect();
  }
}
