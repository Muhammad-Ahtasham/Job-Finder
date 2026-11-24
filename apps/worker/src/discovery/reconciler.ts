import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@jobfinder/database';
import { ENV, type Env } from '../config/env.token';
import { PRISMA } from '../infrastructure.module';
import { ProviderQueuesService } from './provider-queues.service';
import { RunFinalizer } from './run-finalizer';
import { RunPlanner } from './run-planner';
import { RunQueueService } from './run-queue.service';

export interface ReconcileSummary {
  plansRequeued: number;
  tasksRequeued: number;
  runsFinalized: number;
}

/**
 * PostgreSQL is the source of truth; Redis is delivery. This closes every gap between them:
 * a run whose plan job was never enqueued (API crashed after commit), a task whose job was
 * lost (Redis flushed), or a run whose last task finished but never finalized it.
 */
@Injectable()
export class DiscoveryReconciler {
  private readonly logger = new Logger(DiscoveryReconciler.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
    private readonly runQueue: RunQueueService,
    private readonly planner: RunPlanner,
    private readonly providerQueues: ProviderQueuesService,
    private readonly finalizer: RunFinalizer,
  ) {}

  async reconcile(): Promise<ReconcileSummary> {
    const staleBefore = new Date(Date.now() - this.env.DISCOVERY_RECONCILE_STALE_SECONDS * 1000);
    const summary: ReconcileSummary = { plansRequeued: 0, tasksRequeued: 0, runsFinalized: 0 };

    // 1. Runs that were never (fully) planned.
    const unplanned = await this.prisma.searchRun.findMany({
      where: {
        plannedAt: null,
        status: { in: ['QUEUED', 'RUNNING'] },
        createdAt: { lt: staleBefore },
      },
      select: { id: true },
      take: 100,
    });
    for (const run of unplanned) {
      if ((await this.runQueue.ensurePlanJob(run.id)) === 'added') summary.plansRequeued += 1;
    }

    // 2. Open tasks of live runs whose job has disappeared.
    const stale = await this.prisma.discoveryTask.findMany({
      where: {
        status: { in: ['QUEUED', 'RETRYING'] },
        updatedAt: { lt: staleBefore },
        run: { status: 'RUNNING', cancelRequestedAt: null },
      },
      select: { id: true, providerId: true, maxAttempts: true, runId: true },
      take: 500,
    });
    const affectedRuns = new Set<string>();
    for (const task of stale) {
      const result = await this.providerQueues.ensureTaskJob(
        task.providerId,
        task.id,
        task.maxAttempts,
      );
      if (result === 'added') summary.tasksRequeued += 1;
      if (result === 'no-provider') affectedRuns.add(task.runId);
    }
    for (const runId of affectedRuns) await this.planner.deliverOpenTasks(runId); // fails orphaned tasks

    // 3. Fully drained runs that were never finalized.
    const running = await this.prisma.searchRun.findMany({
      where: { status: 'RUNNING', plannedAt: { not: null } },
      select: { id: true },
      take: 100,
    });
    for (const run of running) {
      if (await this.finalizer.finalizeIfDone(run.id)) summary.runsFinalized += 1;
    }

    if (summary.plansRequeued || summary.tasksRequeued || summary.runsFinalized) {
      this.logger.log(`Reconciled: ${JSON.stringify(summary)}`);
    }
    return summary;
  }

  /** Honour provider storage terms: drop raw payloads whose licence window has expired. */
  async purgeExpiredSourceData(): Promise<number> {
    const { count } = await this.prisma.companySource.updateMany({
      where: { expiresAt: { lte: new Date() }, rawData: { not: Prisma.DbNull } },
      data: { rawData: Prisma.DbNull },
    });
    if (count > 0) this.logger.log(`Purged raw data from ${count} expired company source(s)`);
    return count;
  }
}
