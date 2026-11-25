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
  JOB_MATCHING_JOBS,
  matchProjectJobId,
  matchProjectJobSchema,
  QUEUES,
  type MatchProjectJob,
} from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';
import { REDIS } from '../infrastructure.module';
import { MatchProcessor } from './match-processor';

/** Consumes `match-project` jobs (produced by the API on preference changes and by the analysis sweep). */
@Injectable()
export class MatchQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MatchQueueService.name);
  private queue?: Queue<MatchProjectJob>;
  private worker?: Worker<MatchProjectJob>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly processor: MatchProcessor,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue<MatchProjectJob>(QUEUES.JOB_MATCHING, {
      connection: this.redis.duplicate(),
    });
    this.worker = new Worker<MatchProjectJob>(
      QUEUES.JOB_MATCHING,
      async (job) => ({
        ...(await this.processor.matchProject(matchProjectJobSchema.parse(job.data).projectId)),
      }),
      {
        connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
        concurrency: this.env.INTELLIGENCE_CONCURRENCY,
      },
    );
    this.worker.on('error', (error) =>
      this.logger.warn(`${QUEUES.JOB_MATCHING}: ${error.message}`),
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Matching ${job?.data?.projectId} failed: ${error.message}`),
    );
    await this.worker.waitUntilReady();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  /** Idempotent while a job for the project is waiting (deterministic job id). */
  async enqueue(projectId: string): Promise<void> {
    if (!this.queue) throw new Error('MatchQueueService not started');
    await this.queue.add(
      JOB_MATCHING_JOBS.MATCH_PROJECT,
      { projectId },
      {
        jobId: matchProjectJobId(projectId),
        attempts: this.env.INTELLIGENCE_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: { age: 86_400 },
      },
    );
  }
}
