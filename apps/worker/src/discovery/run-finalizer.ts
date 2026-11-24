import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient, RunStatus } from '@jobfinder/database';
import { PRISMA } from '../infrastructure.module';
import { runLockKey } from './discovery.tokens';

const TERMINAL: RunStatus[] = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'];

/** Decides a run's terminal status once every task has reached a terminal state. */
@Injectable()
export class RunFinalizer {
  private readonly logger = new Logger(RunFinalizer.name);

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Idempotent and race-safe: serialized per run, no-op unless the run is fully drained. */
  async finalizeIfDone(runId: string): Promise<RunStatus | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${runLockKey(runId)}, 0))`;
      const run = await tx.searchRun.findUnique({ where: { id: runId } });
      if (!run || TERMINAL.includes(run.status)) return null;
      // Not planned yet: tasks do not exist, so "no active tasks" would be a false positive.
      if (!run.plannedAt) return null;

      const grouped = await tx.discoveryTask.groupBy({
        by: ['status'],
        where: { runId },
        _count: { _all: true },
      });
      const count = (status: string) => grouped.find((g) => g.status === status)?._count._all ?? 0;
      const active = count('QUEUED') + count('RUNNING') + count('RETRYING');
      if (active > 0) return null;

      const failed = count('FAILED');
      const succeeded = count('SUCCEEDED');
      const status: RunStatus = run.cancelRequestedAt
        ? 'CANCELLED'
        : failed === 0
          ? 'COMPLETED'
          : succeeded > 0
            ? 'COMPLETED_WITH_ERRORS'
            : 'FAILED';

      await tx.searchRun.update({ where: { id: runId }, data: { status, finishedAt: new Date() } });
      this.logger.log(`Run ${runId} finished: ${status}`);
      return status;
    });
  }
}
