import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import {
  JOB_MATCHING_JOBS,
  matchProjectJobId,
  QUEUES,
  type MatchProjectJob,
} from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';

/**
 * Producer side of matching. Best-effort: matches are derived data, and the worker's analysis
 * sweep re-enqueues matching whenever jobs change, so a lost message only delays a refresh.
 */
@Injectable()
export class MatchQueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(MatchQueueService.name);
  private readonly connection: Redis;
  private readonly queue: Queue<MatchProjectJob>;

  constructor(@Inject(ENV) env: Env) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (error) => this.logger.warn(`Queue Redis error: ${error.message}`));
    this.queue = new Queue<MatchProjectJob>(QUEUES.JOB_MATCHING, { connection: this.connection });
  }

  /** Idempotent while a job for the project is waiting (deterministic job id). */
  async enqueue(projectId: string): Promise<boolean> {
    try {
      await this.queue.add(
        JOB_MATCHING_JOBS.MATCH_PROJECT,
        { projectId },
        {
          jobId: matchProjectJobId(projectId),
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: { age: 86_400 },
        },
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not enqueue matching for ${projectId}: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
