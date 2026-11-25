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
  ENRICHMENT_JOBS,
  enrichCompanyJobSchema,
  enrichJobId,
  QUEUES,
  type EnrichCompanyJob,
} from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';
import { ensureJob } from '../discovery/queue-utils';
import { PRISMA, REDIS } from '../infrastructure.module';
import { EnrichmentProcessor } from './enrichment-processor';
import { RetryableEnrichmentError } from './enrichment.tokens';

/** A RUNNING run older than this probably lost its job (worker crash + Redis loss). */
const RUNNING_STALE_MS = 10 * 60_000;

/** Consumes `enrich-company` jobs produced by the API and re-delivers any the database still shows as open. */
@Injectable()
export class EnrichmentQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(EnrichmentQueueService.name);
  private queue?: Queue<EnrichCompanyJob>;
  private worker?: Worker<EnrichCompanyJob>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
    private readonly processor: EnrichmentProcessor,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue<EnrichCompanyJob>(QUEUES.ENRICHMENT, {
      connection: this.redis.duplicate(),
    });
    this.worker = new Worker<EnrichCompanyJob>(
      QUEUES.ENRICHMENT,
      async (job) => this.processor.process(enrichCompanyJobSchema.parse(job.data).runId),
      {
        connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
        concurrency: this.env.ENRICHMENT_CONCURRENCY,
      },
    );
    this.worker.on('error', (error) => this.logger.warn(`${QUEUES.ENRICHMENT}: ${error.message}`));
    this.worker.on('failed', (job, error) => {
      void this.onJobFailed(
        job?.data?.runId,
        job?.attemptsMade ?? 0,
        job?.opts.attempts ?? 1,
        error,
      );
    });
    await this.worker.waitUntilReady();
    this.logger.log(`Worker consuming queue "${QUEUES.ENRICHMENT}"`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  private async onJobFailed(
    runId: string | undefined,
    attemptsMade: number,
    maxAttempts: number,
    error: Error,
  ): Promise<void> {
    if (!runId) return;
    try {
      if (attemptsMade >= maxAttempts) {
        const code = error instanceof RetryableEnrichmentError ? error.code : 'ENRICHMENT_FAILED';
        this.logger.error(`Enrichment ${runId} failed permanently: ${error.message}`);
        await this.processor.markFailed(runId, code, error.message);
      } else {
        this.logger.warn(`Enrichment ${runId} attempt ${attemptsMade} failed: ${error.message}`);
        await this.processor.markRetrying(runId, error);
      }
    } catch (inner) {
      this.logger.error(`Could not record failure of ${runId}: ${(inner as Error).message}`);
    }
  }

  /** Idempotent: a live job keeps its place, a finished one is replaced, a missing one is added. */
  async ensureJob(runId: string): Promise<'exists' | 'added'> {
    if (!this.queue) throw new Error('EnrichmentQueueService not started');
    return ensureJob(
      this.queue as Queue,
      ENRICHMENT_JOBS.ENRICH_COMPANY,
      { runId } satisfies EnrichCompanyJob,
      {
        jobId: enrichJobId(runId),
        attempts: this.env.ENRICHMENT_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: this.env.ENRICHMENT_RETRY_BASE_MS },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86_400 },
      },
    );
  }

  /** PostgreSQL is the source of truth: re-deliver runs whose job the queue no longer has. */
  async reconcile(): Promise<{ requeued: number }> {
    const now = Date.now();
    const queuedBefore = new Date(now - this.env.ENRICHMENT_RECONCILE_STALE_SECONDS * 1000);
    const runningBefore = new Date(now - RUNNING_STALE_MS);
    const open = await this.prisma.extractionRun.findMany({
      where: {
        OR: [
          { status: 'QUEUED', createdAt: { lt: queuedBefore } },
          { status: 'RUNNING', startedAt: { lt: runningBefore } },
        ],
      },
      select: { id: true },
      take: 100,
    });
    let requeued = 0;
    for (const run of open) {
      if ((await this.ensureJob(run.id)) === 'added') requeued += 1;
    }
    if (requeued > 0)
      this.logger.warn(`Re-enqueued ${requeued} enrichment run(s) missing from the queue`);
    return { requeued };
  }
}
