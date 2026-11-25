import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import type { PrismaClient } from '@jobfinder/database';
import {
  EXPORT_JOBS,
  exportJobId,
  generateExportJobSchema,
  QUEUES,
  type GenerateExportJob,
} from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';
import { ensureJob } from '../discovery/queue-utils';
import { PRISMA, REDIS } from '../infrastructure.module';
import { ExportProcessor } from './export-processor';

const RUNNING_STALE_MS = 15 * 60_000;

/** Consumes `generate-export` jobs and re-delivers exports the queue lost. */
@Injectable()
export class ExportQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExportQueueService.name);
  private queue?: Queue<GenerateExportJob>;
  private worker?: Worker<GenerateExportJob>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
    private readonly processor: ExportProcessor,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue<GenerateExportJob>(QUEUES.EXPORTS, {
      connection: this.redis.duplicate(),
    });
    this.worker = new Worker<GenerateExportJob>(
      QUEUES.EXPORTS,
      async (job) => this.processor.process(generateExportJobSchema.parse(job.data).exportId),
      {
        connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
        concurrency: this.env.EXPORT_CONCURRENCY,
      },
    );
    this.worker.on('error', (error) => this.logger.warn(`${QUEUES.EXPORTS}: ${error.message}`));
    this.worker.on('failed', (job, error) => {
      void this.onJobFailed(
        job?.data?.exportId,
        job?.attemptsMade ?? 0,
        job?.opts.attempts ?? 1,
        error,
      );
    });
    await this.worker.waitUntilReady();
    this.logger.log(`Worker consuming queue "${QUEUES.EXPORTS}"`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  private async onJobFailed(exportId: string | undefined, made: number, max: number, error: Error) {
    if (!exportId) return;
    try {
      if (made >= max) {
        this.logger.error(`Export ${exportId} failed permanently: ${error.message}`);
        await this.processor.markFailed(exportId, 'EXPORT_FAILED', error.message);
      } else {
        await this.processor.markRetrying(exportId, error);
      }
    } catch (inner) {
      this.logger.error(
        `Could not record failure of export ${exportId}: ${(inner as Error).message}`,
      );
    }
  }

  async ensureJob(exportId: string): Promise<'exists' | 'added'> {
    if (!this.queue) throw new Error('ExportQueueService not started');
    return ensureJob(
      this.queue as Queue,
      EXPORT_JOBS.GENERATE,
      { exportId } satisfies GenerateExportJob,
      {
        jobId: exportJobId(exportId),
        attempts: this.env.EXPORT_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: this.env.EXPORT_RETRY_BASE_MS },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86_400 },
      },
    );
  }

  /** Re-enqueues lost exports, then deletes files past their retention. */
  async reconcile(): Promise<{ requeued: number; expired: number }> {
    const now = Date.now();
    const open = await this.prisma.export.findMany({
      where: {
        OR: [
          {
            status: 'QUEUED',
            createdAt: { lt: new Date(now - this.env.EXPORT_RECONCILE_STALE_SECONDS * 1000) },
          },
          { status: 'RUNNING', startedAt: { lt: new Date(now - RUNNING_STALE_MS) } },
        ],
      },
      select: { id: true },
      take: 100,
    });
    let requeued = 0;
    for (const item of open) if ((await this.ensureJob(item.id)) === 'added') requeued += 1;
    if (requeued > 0) this.logger.warn(`Re-enqueued ${requeued} export(s) missing from the queue`);
    return { requeued, expired: await this.processor.expireOld() };
  }
}
