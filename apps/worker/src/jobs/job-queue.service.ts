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
  discoverJobsJobSchema,
  JOB_DISCOVERY_JOBS,
  jobRunJobId,
  QUEUES,
  type DiscoverJobsJob,
} from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';
import { ensureJob } from '../discovery/queue-utils';
import { PRISMA, REDIS } from '../infrastructure.module';
import { JobDiscoveryProcessor } from './job-discovery-processor';
import { RetryableJobError } from './jobs.tokens';

const RUNNING_STALE_MS = 15 * 60_000;

/** Consumes `discover-jobs` jobs produced by the API and re-delivers runs the queue lost. */
@Injectable()
export class JobQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobQueueService.name);
  private queue?: Queue<DiscoverJobsJob>;
  private worker?: Worker<DiscoverJobsJob>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
    private readonly processor: JobDiscoveryProcessor,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue<DiscoverJobsJob>(QUEUES.JOB_DISCOVERY, {
      connection: this.redis.duplicate(),
    });
    this.worker = new Worker<DiscoverJobsJob>(
      QUEUES.JOB_DISCOVERY,
      async (job) => this.processor.process(discoverJobsJobSchema.parse(job.data).runId),
      {
        connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
        concurrency: this.env.JOBS_CONCURRENCY,
      },
    );
    this.worker.on('error', (error) =>
      this.logger.warn(`${QUEUES.JOB_DISCOVERY}: ${error.message}`),
    );
    this.worker.on('failed', (job, error) => {
      void this.onJobFailed(
        job?.data?.runId,
        job?.attemptsMade ?? 0,
        job?.opts.attempts ?? 1,
        error,
      );
    });
    await this.worker.waitUntilReady();
    this.logger.log(`Worker consuming queue "${QUEUES.JOB_DISCOVERY}"`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  private async onJobFailed(runId: string | undefined, made: number, max: number, error: Error) {
    if (!runId) return;
    try {
      if (made >= max) {
        this.logger.error(`Job run ${runId} failed permanently: ${error.message}`);
        await this.processor.markFailed(
          runId,
          error instanceof RetryableJobError ? error.code : 'JOB_DISCOVERY_FAILED',
          error.message,
        );
      } else {
        await this.processor.markRetrying(runId, error);
      }
    } catch (inner) {
      this.logger.error(`Could not record failure of ${runId}: ${(inner as Error).message}`);
    }
  }

  async ensureJob(runId: string): Promise<'exists' | 'added'> {
    if (!this.queue) throw new Error('JobQueueService not started');
    return ensureJob(
      this.queue as Queue,
      JOB_DISCOVERY_JOBS.DISCOVER_JOBS,
      { runId } satisfies DiscoverJobsJob,
      {
        jobId: jobRunJobId(runId),
        attempts: this.env.JOBS_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: this.env.JOBS_RETRY_BASE_MS },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86_400 },
      },
    );
  }

  async reconcile(): Promise<{ requeued: number }> {
    const now = Date.now();
    const open = await this.prisma.jobRun.findMany({
      where: {
        OR: [
          {
            status: 'QUEUED',
            createdAt: { lt: new Date(now - this.env.JOBS_RECONCILE_STALE_SECONDS * 1000) },
          },
          { status: 'RUNNING', startedAt: { lt: new Date(now - RUNNING_STALE_MS) } },
        ],
      },
      select: { id: true },
      take: 100,
    });
    let requeued = 0;
    for (const run of open) if ((await this.ensureJob(run.id)) === 'added') requeued += 1;
    if (requeued > 0) this.logger.warn(`Re-enqueued ${requeued} job run(s) missing from the queue`);
    return { requeued };
  }
}
