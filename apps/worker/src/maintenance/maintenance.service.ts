import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { MAINTENANCE_JOBS, QUEUES } from '@jobfinder/contracts';
import type { PrismaClient } from '@jobfinder/database';
import { ENV, type Env } from '../config/env.token';
import { PRISMA, REDIS } from '../infrastructure.module';

const HOUR_MS = 3_600_000;

/**
 * The first real BullMQ consumer: periodic housekeeping. Proves the worker ↔ Redis
 * path end to end (the scheduler survives restarts because it is keyed by id).
 * Feature queues (discovery, crawling, ...) arrive in later phases.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(QUEUES.MAINTENANCE, { connection: this.redis.duplicate() });
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOBS.PURGE_EXPIRED_SESSIONS,
      { every: HOUR_MS },
      {
        name: MAINTENANCE_JOBS.PURGE_EXPIRED_SESSIONS,
        opts: { removeOnComplete: 24, removeOnFail: 100 },
      },
    );

    this.worker = new Worker(QUEUES.MAINTENANCE, (job) => this.process(job), {
      connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
      concurrency: 1,
    });
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Job ${job?.name} failed: ${error.message}`),
    );
    await this.worker.waitUntilReady();
    this.logger.log(`Worker consuming queue "${QUEUES.MAINTENANCE}"`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  async process(job: Job): Promise<{ removed: number } | undefined> {
    if (job.name === MAINTENANCE_JOBS.PURGE_EXPIRED_SESSIONS) {
      return { removed: await this.purgeExpiredSessions() };
    }
    this.logger.warn(`Unknown maintenance job "${job.name}"`);
    return undefined;
  }

  /** Idempotent by nature: deleting already-deleted rows is a no-op. */
  async purgeExpiredSessions(): Promise<number> {
    const idleLimit = new Date(Date.now() - this.env.SESSION_IDLE_TTL_HOURS * HOUR_MS);
    const { count } = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lte: new Date() } }, { lastSeenAt: { lte: idleLimit } }] },
    });
    if (count > 0) this.logger.log(`Purged ${count} expired session(s)`);
    return count;
  }
}
