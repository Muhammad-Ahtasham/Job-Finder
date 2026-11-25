import {
  Inject,
  Injectable,
  Optional,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { MAINTENANCE_JOBS, QUEUES } from '@jobfinder/contracts';
import type { PrismaClient } from '@jobfinder/database';
import { ENV, type Env } from '../config/env.token';
import { DiscoveryReconciler } from '../discovery/reconciler';
import { EnrichmentQueueService } from '../enrichment/enrichment-queue.service';
import { ExportQueueService } from '../exports/export-queue.service';
import { MonitoringQueueService } from '../monitoring/monitoring-queue.service';
import { IntelligenceService } from '../intelligence/intelligence.service';
import { JobQueueService } from '../jobs/job-queue.service';
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
    private readonly reconciler: DiscoveryReconciler,
    private readonly enrichment: EnrichmentQueueService,
    private readonly jobs: JobQueueService,
    @Optional() private readonly intelligence?: IntelligenceService,
    @Optional() private readonly exportQueue?: ExportQueueService,
    @Optional() private readonly monitoring?: MonitoringQueueService,
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

    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOBS.RECONCILE_DISCOVERY,
      { every: 30_000 },
      {
        name: MAINTENANCE_JOBS.RECONCILE_DISCOVERY,
        opts: { removeOnComplete: 5, removeOnFail: 50 },
      },
    );
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOBS.RECONCILE_ENRICHMENT,
      { every: 30_000 },
      {
        name: MAINTENANCE_JOBS.RECONCILE_ENRICHMENT,
        opts: { removeOnComplete: 5, removeOnFail: 50 },
      },
    );
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOBS.RECONCILE_JOBS,
      { every: 30_000 },
      {
        name: MAINTENANCE_JOBS.RECONCILE_JOBS,
        opts: { removeOnComplete: 5, removeOnFail: 50 },
      },
    );
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOBS.SWEEP_INTELLIGENCE,
      { every: 30_000 },
      {
        name: MAINTENANCE_JOBS.SWEEP_INTELLIGENCE,
        opts: { removeOnComplete: 5, removeOnFail: 50 },
      },
    );
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOBS.RECONCILE_EXPORTS,
      { every: 30_000 },
      {
        name: MAINTENANCE_JOBS.RECONCILE_EXPORTS,
        opts: { removeOnComplete: 5, removeOnFail: 50 },
      },
    );
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOBS.MONITORING_TICK,
      { every: 60_000 },
      {
        name: MAINTENANCE_JOBS.MONITORING_TICK,
        opts: { removeOnComplete: 5, removeOnFail: 50 },
      },
    );
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOBS.PURGE_EXPIRED_SOURCE_DATA,
      { every: HOUR_MS },
      {
        name: MAINTENANCE_JOBS.PURGE_EXPIRED_SOURCE_DATA,
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

  async process(job: Job): Promise<object | undefined> {
    if (job.name === MAINTENANCE_JOBS.PURGE_EXPIRED_SESSIONS) {
      return { removed: await this.purgeExpiredSessions() };
    }
    if (job.name === MAINTENANCE_JOBS.RECONCILE_DISCOVERY) {
      return this.reconciler.reconcile();
    }
    if (job.name === MAINTENANCE_JOBS.RECONCILE_JOBS) {
      return this.jobs.reconcile();
    }
    if (job.name === MAINTENANCE_JOBS.MONITORING_TICK) {
      return this.monitoring ? this.monitoring.tick() : undefined;
    }
    if (job.name === MAINTENANCE_JOBS.RECONCILE_EXPORTS) {
      return this.exportQueue ? this.exportQueue.reconcile() : undefined;
    }
    if (job.name === MAINTENANCE_JOBS.SWEEP_INTELLIGENCE) {
      return this.intelligence ? this.intelligence.sweep() : undefined;
    }
    if (job.name === MAINTENANCE_JOBS.RECONCILE_ENRICHMENT) {
      return this.enrichment.reconcile();
    }
    if (job.name === MAINTENANCE_JOBS.PURGE_EXPIRED_SOURCE_DATA) {
      return { purged: await this.reconciler.purgeExpiredSourceData() };
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
