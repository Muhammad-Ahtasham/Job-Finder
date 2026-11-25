import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { JobListResponse, JobRefreshResponse, JobSourcesResponse } from '@jobfinder/contracts';
import { isUniqueViolation } from '../common/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { JobQueueService } from '../queue/job-queue.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { toCompanyPage } from './enrichment.mapper';
import { toJob, toJobRun, toJobSource } from './jobs.mapper';

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueueService,
  ) {}

  private async company(workspace: WorkspaceContext, id: string) {
    const company = await this.prisma.client.company.findFirst({
      where: { id, workspaceId: workspace.id },
    });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  /**
   * Start finding career pages and fetching jobs. Idempotent: while a run is queued or running,
   * further calls return that run (the database's unique `activeKey` guarantees it).
   */
  async refresh(
    workspace: WorkspaceContext,
    userId: string,
    companyId: string,
  ): Promise<JobRefreshResponse> {
    const company = await this.company(workspace, companyId);
    if (company.status !== 'ACTIVE') {
      throw new ConflictException(`Company was merged into ${company.mergedIntoId}`);
    }
    let reused = false;
    let run;
    try {
      run = await this.prisma.client.jobRun.create({
        data: {
          workspaceId: workspace.id,
          companyId: company.id,
          requestedById: userId,
          activeKey: company.id,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      run = await this.prisma.client.jobRun.findUnique({ where: { activeKey: company.id } });
      if (!run) throw error; // finished between the two statements: the caller may simply retry
      reused = true;
    }
    await this.queue.enqueue(run.id);
    return { run: toJobRun(run), reused };
  }

  async list(
    workspace: WorkspaceContext,
    companyId: string,
    query: {
      status: 'OPEN' | 'CLOSED';
      employmentType?: string;
      workplaceType?: string;
      limit: number;
      cursor?: string;
    },
  ): Promise<JobListResponse> {
    await this.company(workspace, companyId);
    const rows = await this.prisma.client.job.findMany({
      where: {
        companyId,
        workspaceId: workspace.id,
        status: query.status,
        ...(query.employmentType ? { employmentType: query.employmentType as never } : {}),
        ...(query.workplaceType ? { workplaceType: query.workplaceType as never } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: { source: { select: { providerId: true } } },
    });
    const page = rows.slice(0, query.limit);
    return {
      companyId,
      items: page.map(toJob),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }

  async sources(workspace: WorkspaceContext, companyId: string): Promise<JobSourcesResponse> {
    await this.company(workspace, companyId);
    const [pages, sources, runs, open] = await Promise.all([
      this.prisma.client.companyPage.findMany({
        where: { companyId, type: { in: ['CAREERS', 'JOBS'] } },
        orderBy: [{ typeConfidence: 'desc' }, { url: 'asc' }],
      }),
      this.prisma.client.jobSource.findMany({
        where: { companyId },
        orderBy: [{ createdAt: 'asc' }],
        include: { checks: { orderBy: { startedAt: 'desc' }, take: 5 } },
      }),
      this.prisma.client.jobRun.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.client.job.groupBy({
        by: ['sourceId'],
        where: { companyId, status: 'OPEN' },
        _count: { _all: true },
      }),
    ]);
    const openBySource = new Map(open.map((o) => [o.sourceId, o._count._all]));
    const answered = sources.some(
      (s) => s.lastOutcome === 'JOBS' || s.lastOutcome === 'NO_OPENINGS',
    );
    return {
      companyId,
      careerPages: pages.map(toCompanyPage),
      sources: sources.map((s) => toJobSource(s, openBySource.get(s.id) ?? 0, s.checks)),
      runs: runs.map(toJobRun),
      vacancyKnowledge: answered ? 'KNOWN' : 'UNKNOWN',
    };
  }
}
