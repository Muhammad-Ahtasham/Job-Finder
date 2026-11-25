import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { ENRICHMENT_JOBS, enrichJobId, QUEUES, type EnrichCompanyJob } from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';

/**
 * Producer side of website enrichment. Enqueueing is best-effort: the ExtractionRun row is the
 * source of truth and the worker's reconciler re-enqueues any run whose job was lost.
 */
@Injectable()
export class EnrichmentQueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(EnrichmentQueueService.name);
  private readonly connection: Redis;
  private readonly queue: Queue<EnrichCompanyJob>;

  constructor(@Inject(ENV) env: Env) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (error) => this.logger.warn(`Queue Redis error: ${error.message}`));
    this.queue = new Queue<EnrichCompanyJob>(QUEUES.ENRICHMENT, { connection: this.connection });
  }

  /** Idempotent: the deterministic job id means a repeated call cannot create a second job. */
  async enqueue(runId: string): Promise<boolean> {
    try {
      await this.queue.add(
        ENRICHMENT_JOBS.ENRICH_COMPANY,
        { runId },
        {
          jobId: enrichJobId(runId),
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86_400 },
        },
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not enqueue enrichment ${runId}; the reconciler will retry: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
