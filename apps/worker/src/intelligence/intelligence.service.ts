import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@jobfinder/database';
import { ENV, type Env } from '../config/env.token';
import { PRISMA } from '../infrastructure.module';
import { JobAnalyzer } from './job-analyzer';
import { MatchQueueService } from './match-queue.service';
import { StatusSweeper } from './status-sweeper';

/** The periodic pass: status transitions, analysis of new/changed postings, then re-matching. */
@Injectable()
export class IntelligenceService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
    private readonly sweeper: StatusSweeper,
    private readonly analyzer: JobAnalyzer,
    private readonly matches: MatchQueueService,
  ) {}

  async sweep(): Promise<object> {
    const statuses = await this.sweeper.sweep();
    const { analyzed, workspaceIds } = await this.analyzer.analyzePending(
      this.env.INTELLIGENCE_BATCH_SIZE,
    );
    let enqueued = 0;
    if (workspaceIds.length > 0) {
      const projects = await this.prisma.searchProject.findMany({
        where: { workspaceId: { in: workspaceIds } },
        select: { id: true },
      });
      for (const p of projects) {
        await this.matches.enqueue(p.id);
        enqueued += 1;
      }
    }
    return { ...statuses, analyzed, matchJobsEnqueued: enqueued };
  }
}
