import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { MonitoringSchedule as ScheduleRow, JobSource, Prisma } from '@jobfinder/database';
import { monitoringIntervals } from '@jobfinder/config';
import {
  type CompanyMonitoring,
  type MonitoringListQuery,
  type MonitoringListResponse,
  type MonitoringSchedule,
  type UpdateScheduleRequest,
} from '@jobfinder/contracts';
import { scheduleHealth, setCompanyMonitoring } from '@jobfinder/monitoring';
import { ENV, type Env } from '../config/env.token';
import { PrismaService } from '../prisma/prisma.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';

type ScheduleWithRefs = ScheduleRow & {
  company: { displayName: string };
  jobSource: Pick<JobSource, 'id' | 'providerId' | 'boardUrl'> | null;
};

const INCLUDE = {
  company: { select: { displayName: true } },
  jobSource: { select: { id: true, providerId: true, boardUrl: true } },
} satisfies Prisma.MonitoringScheduleInclude;

export function toSchedule(row: ScheduleWithRefs): MonitoringSchedule {
  return {
    id: row.id,
    companyId: row.companyId,
    companyName: row.company.displayName,
    kind: row.kind,
    source: row.jobSource
      ? { id: row.jobSource.id, providerId: row.jobSource.providerId, url: row.jobSource.boardUrl }
      : null,
    enabled: row.enabled,
    intervalMinutes: row.intervalMinutes,
    nextRunAt: row.nextRunAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastOutcome: row.lastOutcome,
    consecutiveFailures: row.consecutiveFailures,
    lastError:
      row.lastErrorCode || row.lastErrorMessage
        ? {
            code: row.lastErrorCode,
            message: row.lastErrorMessage,
            at: row.lastErrorAt?.toISOString() ?? null,
          }
        : null,
    health: scheduleHealth(row),
  };
}

@Injectable()
export class MonitoringService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async company(workspace: WorkspaceContext, id: string) {
    const company = await this.prisma.client.company.findFirst({
      where: { id, workspaceId: workspace.id },
      select: { id: true, workspaceId: true, website: true, status: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private async schedule(workspace: WorkspaceContext, id: string): Promise<ScheduleWithRefs> {
    const row = await this.prisma.client.monitoringSchedule.findFirst({
      where: { id, workspaceId: workspace.id },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundException('Schedule not found');
    return row;
  }

  async list(
    workspace: WorkspaceContext,
    query: MonitoringListQuery,
  ): Promise<MonitoringListResponse> {
    const rows = await this.prisma.client.monitoringSchedule.findMany({
      where: {
        workspaceId: workspace.id,
        ...(query.companyId ? { companyId: query.companyId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: INCLUDE,
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toSchedule),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }

  async forCompany(workspace: WorkspaceContext, companyId: string): Promise<CompanyMonitoring> {
    await this.company(workspace, companyId);
    const [schedules, checks] = await Promise.all([
      this.prisma.client.monitoringSchedule.findMany({
        where: { companyId, workspaceId: workspace.id },
        orderBy: [{ kind: 'asc' }, { id: 'asc' }],
        include: INCLUDE,
      }),
      this.prisma.client.websiteCheck.findMany({
        where: { companyId, workspaceId: workspace.id },
        orderBy: { id: 'desc' },
        take: 10,
      }),
    ]);
    return {
      companyId,
      enabled: schedules.some((s) => s.enabled),
      schedules: schedules.map(toSchedule),
      recentWebsiteChecks: checks.map((c) => ({
        id: c.id,
        outcome: c.outcome,
        url: c.url,
        httpStatus: c.httpStatus,
        finalDomain: c.finalDomain,
        changeKind: c.changeKind,
        errorCode: c.errorCode,
        errorMessage: c.errorMessage,
        startedAt: c.startedAt.toISOString(),
      })),
    };
  }

  /** Turn monitoring of a company on or off. Turning it on also creates any missing schedules. */
  async setCompany(
    workspace: WorkspaceContext,
    companyId: string,
    enabled: boolean,
  ): Promise<CompanyMonitoring> {
    const company = await this.company(workspace, companyId);
    if (company.status !== 'ACTIVE')
      throw new ConflictException('The company was merged into another one');
    await setCompanyMonitoring(this.prisma.client, company, enabled, {
      intervals: monitoringIntervals(this.env),
    });
    return this.forCompany(workspace, companyId);
  }

  async update(
    workspace: WorkspaceContext,
    id: string,
    input: UpdateScheduleRequest,
  ): Promise<MonitoringSchedule> {
    const current = await this.schedule(workspace, id);
    const now = new Date();
    const data: Prisma.MonitoringScheduleUpdateInput = {};
    if (input.enabled !== undefined) {
      data.enabled = input.enabled;
      if (!input.enabled) data.lockedUntil = null;
    }
    if (input.intervalMinutes !== undefined) {
      data.intervalMinutes = input.intervalMinutes;
      // A shorter interval takes effect now; a longer one at the next planned run.
      const sooner = new Date(now.getTime() + input.intervalMinutes * 60_000);
      if (sooner < current.nextRunAt) data.nextRunAt = sooner;
    }
    await this.prisma.client.monitoringSchedule.update({ where: { id }, data });
    return toSchedule(await this.schedule(workspace, id));
  }

  /** Makes a schedule due now; the scheduler picks it up within a minute. */
  async runNow(workspace: WorkspaceContext, id: string): Promise<MonitoringSchedule> {
    const current = await this.schedule(workspace, id);
    if (!current.enabled) throw new ConflictException('Enable monitoring before running a check');
    await this.prisma.client.monitoringSchedule.update({
      where: { id },
      data: { nextRunAt: new Date() },
    });
    return toSchedule(await this.schedule(workspace, id));
  }
}
