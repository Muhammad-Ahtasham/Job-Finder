import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { EXPORT_JOBS, exportJobId, QUEUES, type GenerateExportJob } from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';

/**
 * Producer side of exports. Enqueueing is best-effort: the Export row is the source of truth and
 * the worker's reconciler re-enqueues any export whose job was lost.
 */
@Injectable()
export class ExportQueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(ExportQueueService.name);
  private readonly connection: Redis;
  private readonly queue: Queue<GenerateExportJob>;

  constructor(@Inject(ENV) env: Env) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (error) => this.logger.warn(`Queue Redis error: ${error.message}`));
    this.queue = new Queue<GenerateExportJob>(QUEUES.EXPORTS, { connection: this.connection });
  }

  /** Idempotent: the deterministic job id means a repeated call cannot create a second job. */
  async enqueue(exportId: string): Promise<boolean> {
    try {
      await this.queue.add(
        EXPORT_JOBS.GENERATE,
        { exportId },
        {
          jobId: exportJobId(exportId),
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86_400 },
        },
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not enqueue export ${exportId}; the reconciler will retry: ${
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
