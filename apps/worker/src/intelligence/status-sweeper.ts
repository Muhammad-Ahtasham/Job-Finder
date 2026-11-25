import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@jobfinder/database';
import { nextJobStatus, type JobStatusValue } from '@jobfinder/intelligence';
import { ENV, type Env } from '../config/env.token';
import { PRISMA } from '../infrastructure.module';

const DAY_MS = 86_400_000;

/**
 * Time-driven status transitions, all decided by `nextJobStatus`:
 *  - a job past its published expiry date becomes EXPIRED;
 *  - an OPEN job no check has confirmed for JOBS_STALE_AFTER_DAYS becomes UNKNOWN.
 * Nothing here can CLOSE a job: only an authoritative source's answer does that.
 */
@Injectable()
export class StatusSweeper {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async sweep(now = new Date()): Promise<{ expired: number; unknown: number }> {
    const staleAfterMs = this.env.JOBS_STALE_AFTER_DAYS * DAY_MS;
    const candidates = await this.prisma.job.findMany({
      where: {
        status: { in: ['OPEN', 'UNKNOWN'] },
        OR: [
          { expiresAt: { lte: now } },
          { status: 'OPEN', lastSeenAt: { lt: new Date(now.getTime() - staleAfterMs) } },
        ],
      },
      orderBy: { id: 'asc' },
      take: 500,
    });
    const result = { expired: 0, unknown: 0 };
    for (const job of candidates) {
      const change = nextJobStatus(job.status as JobStatusValue, {
        type: 'SWEEP',
        now,
        expiresAt: job.expiresAt,
        lastSeenAt: job.lastSeenAt,
        staleAfterMs,
      });
      if (!change) continue;
      await this.prisma.$transaction([
        this.prisma.job.updateMany({
          // Guard: only if nothing else moved the job since we read it.
          where: { id: job.id, status: job.status },
          data: {
            status: change.status,
            statusReason: change.reason,
            statusChangedAt: now,
            ...(change.status === 'EXPIRED' ? { closedAt: now } : {}),
          },
        }),
        this.prisma.jobObservation.create({
          data: {
            workspaceId: job.workspaceId,
            jobId: job.id,
            kind: 'STATUS_CHANGED',
            fromStatus: job.status,
            toStatus: change.status,
            reason: change.reason,
            observedAt: now,
          },
        }),
      ]);
      if (change.status === 'EXPIRED') result.expired += 1;
      else result.unknown += 1;
    }
    return result;
  }
}
