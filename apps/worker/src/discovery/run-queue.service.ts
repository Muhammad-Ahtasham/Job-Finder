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
  planJobId,
  planRunJobSchema,
  QUEUES,
  type PlanRunJob,
} from '@jobfinder/contracts';
import { REDIS } from '../infrastructure.module';
import { ensureJob } from './queue-utils';
import { ProviderQueuesService } from './provider-queues.service';
import { RunPlanner } from './run-planner';

/** Consumes "plan this run" jobs produced by the API (and by the reconciler). */
@Injectable()
export class RunQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RunQueueService.name);
  private queue?: Queue<PlanRunJob>;
  private worker?: Worker<PlanRunJob>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly planner: RunPlanner,
    private readonly providerQueues: ProviderQueuesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.providerQueues.start();
    this.queue = new Queue<PlanRunJob>(QUEUES.DISCOVERY_RUNS, {
      connection: this.redis.duplicate(),
    });
    this.worker = new Worker<PlanRunJob>(
      QUEUES.DISCOVERY_RUNS,
      async (job) => this.planner.plan(planRunJobSchema.parse(job.data).runId),
      { connection: this.redis.duplicate({ maxRetriesPerRequest: null }), concurrency: 2 },
    );
    this.worker.on('error', (error) =>
      this.logger.warn(`${QUEUES.DISCOVERY_RUNS}: ${error.message}`),
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Plan job ${job?.id} failed: ${error.message}`),
    );
    await this.worker.waitUntilReady();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  async ensurePlanJob(runId: string): Promise<'exists' | 'added'> {
    if (!this.queue) throw new Error('RunQueueService not started');
    return ensureJob(this.queue as Queue, DISCOVERY_JOBS.PLAN_RUN, { runId } satisfies PlanRunJob, {
      jobId: planJobId(runId),
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86_400 },
    });
  }
}
