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
  MONITORING_JOBS,
  monitoringJobId,
  QUEUES,
  runScheduleJobSchema,
  type RunScheduleJob,
} from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';
import { ensureJob } from '../discovery/queue-utils';
import { PRISMA, REDIS } from '../infrastructure.module';
import { MonitoringProcessor } from './monitoring-processor';
import { NotificationService } from './notification.service';

/**
 * The scheduler. Once a minute `tick` finds due schedules, claims each one (so it is queued
 * once even with several workers) and hands it to the `monitoring` queue, whose consumer runs
 * the check. The database holds the schedule; the queue only delivers it, so a lost message is
 * simply picked up again when its lock expires.
 */
@Injectable()
export class MonitoringQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MonitoringQueueService.name);
  private queue?: Queue<RunScheduleJob>;
  private worker?: Worker<RunScheduleJob>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
    private readonly processor: MonitoringProcessor,
    private readonly notifications: NotificationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue<RunScheduleJob>(QUEUES.MONITORING, {
      connection: this.redis.duplicate(),
    });
    this.worker = new Worker<RunScheduleJob>(
      QUEUES.MONITORING,
      async (job) => ({
        ...(await this.processor.run(runScheduleJobSchema.parse(job.data).scheduleId)),
      }),
      {
        connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
        concurrency: this.env.MONITOR_CONCURRENCY,
      },
    );
    this.worker.on('error', (error) => this.logger.warn(`${QUEUES.MONITORING}: ${error.message}`));
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Monitoring ${job?.data?.scheduleId} failed: ${error.message}`),
    );
    await this.worker.waitUntilReady();
    this.logger.log(`Worker consuming queue "${QUEUES.MONITORING}"`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  /** Queues a schedule's check now (the caller has already claimed it). */
  async enqueue(scheduleId: string): Promise<'exists' | 'added'> {
    if (!this.queue) throw new Error('MonitoringQueueService not started');
    return ensureJob(
      this.queue as Queue,
      MONITORING_JOBS.RUN_SCHEDULE,
      { scheduleId } satisfies RunScheduleJob,
      {
        jobId: monitoringJobId(scheduleId),
        attempts: this.env.MONITOR_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86_400 },
      },
    );
  }

  /**
   * Claims and queues the schedules that are due. A claim is an atomic guarded update, so two
   * ticks (or two workers) can never queue the same schedule twice; if the check never
   * completes, the claim lapses after MONITOR_LOCK_MINUTES and the schedule is picked up again.
   */
  async tick(now = new Date()): Promise<{ claimed: number; notificationsDelivered: number }> {
    if (!this.env.MONITOR_ENABLED) return { claimed: 0, notificationsDelivered: 0 };
    const unlocked = [{ lockedUntil: null }, { lockedUntil: { lt: now } }];
    const due = await this.prisma.monitoringSchedule.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
        OR: unlocked,
        company: { status: 'ACTIVE' },
      },
      orderBy: { nextRunAt: 'asc' },
      take: this.env.MONITOR_BATCH_SIZE,
      select: { id: true },
    });
    let claimed = 0;
    for (const { id } of due) {
      const won = await this.prisma.monitoringSchedule.updateMany({
        where: { id, enabled: true, nextRunAt: { lte: now }, OR: unlocked },
        data: { lockedUntil: new Date(now.getTime() + this.processor.lockMs) },
      });
      if (won.count !== 1) continue;
      await this.enqueue(id);
      claimed += 1;
    }
    if (claimed > 0) this.logger.log(`Queued ${claimed} due monitoring check(s)`);
    // Same minute: deliver notifications to channels beyond the in-app feed.
    const notificationsDelivered = await this.notifications.dispatch();
    return { claimed, notificationsDelivered };
  }
}
