import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SearchRun } from '@jobfinder/database';
import {
  ACTIVE_RUN_STATUSES,
  type DiscoveryResultListResponse,
  type PaginationQuery,
  type ProviderProgress,
  type Run,
  type RunListResponse,
  type RunProgress,
  type TaskCounts,
} from '@jobfinder/contracts';
import { isUniqueViolation } from '../common/prisma-errors';
import { toCompanySummary } from '../companies/company.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { DiscoveryQueueService } from '../queue/discovery-queue.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { addToCounts, emptyTaskCounts, toRun, type RunConfig } from './run.mapper';

const TERMINAL: SearchRun['status'][] = [
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
];

@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: DiscoveryQueueService,
  ) {}

  /** Used by the projects module to attach each project's latest run. */
  async toRuns(runs: SearchRun[]): Promise<Run[]> {
    if (runs.length === 0) return [];
    const grouped = await this.prisma.client.discoveryTask.groupBy({
      by: ['runId', 'status'],
      where: { runId: { in: runs.map((r) => r.id) } },
      _count: { _all: true },
    });
    const byRun = new Map<string, TaskCounts>();
    for (const row of grouped) {
      const counts = byRun.get(row.runId) ?? emptyTaskCounts();
      addToCounts(counts, row.status, row._count._all);
      byRun.set(row.runId, counts);
    }
    return runs.map((run) => toRun(run, byRun.get(run.id) ?? emptyTaskCounts()));
  }

  async start(
    workspace: WorkspaceContext,
    userId: string,
    projectId: string,
    idempotencyKey: string | undefined,
  ): Promise<Run> {
    const project = await this.prisma.client.searchProject.findFirst({
      where: { id: projectId, workspaceId: workspace.id },
    });
    if (!project) throw new NotFoundException('Project not found');

    const config: RunConfig = {
      country: project.country,
      city: project.city,
      industry: project.industry,
      keywords: project.keywords,
    };

    let run: SearchRun;
    try {
      run = await this.prisma.client.$transaction(async (tx) => {
        // Serialize starts per project so two concurrent requests cannot both pass the check.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`project:${projectId}`}, 0))`;

        if (idempotencyKey) {
          const existing = await tx.searchRun.findUnique({
            where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
          });
          if (existing) return existing;
        }
        const active = await tx.searchRun.findFirst({
          where: { projectId, status: { in: ACTIVE_RUN_STATUSES } },
          select: { id: true },
        });
        if (active)
          throw new ConflictException('A discovery run is already in progress for this project');

        return tx.searchRun.create({
          data: {
            projectId,
            workspaceId: workspace.id,
            requestedById: userId,
            config: config as unknown as object,
            idempotencyKey,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error) && idempotencyKey) {
        // Lost a race on the idempotency key: return the winner.
        const existing = await this.prisma.client.searchRun.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
        });
        if (existing) return (await this.toRuns([existing]))[0]!;
      }
      throw error;
    }

    // Best effort; the worker's reconciler re-enqueues unplanned runs.
    await this.queue.enqueuePlan(run.id);
    return (await this.toRuns([run]))[0]!;
  }

  async listForProject(workspace: WorkspaceContext, projectId: string): Promise<RunListResponse> {
    const project = await this.prisma.client.searchProject.findFirst({
      where: { id: projectId, workspaceId: workspace.id },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const runs = await this.prisma.client.searchRun.findMany({
      where: { projectId, workspaceId: workspace.id },
      orderBy: { id: 'desc' },
      take: 50,
    });
    return { items: await this.toRuns(runs) };
  }

  private async findRun(workspace: WorkspaceContext, runId: string): Promise<SearchRun> {
    const run = await this.prisma.client.searchRun.findFirst({
      where: { id: runId, workspaceId: workspace.id },
    });
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  async get(workspace: WorkspaceContext, runId: string): Promise<Run> {
    return (await this.toRuns([await this.findRun(workspace, runId)]))[0]!;
  }

  async progress(workspace: WorkspaceContext, runId: string): Promise<RunProgress> {
    const run = await this.findRun(workspace, runId);
    const config = run.config as unknown as RunConfig;

    const [grouped, failing] = await Promise.all([
      this.prisma.client.discoveryTask.groupBy({
        by: ['providerId', 'status'],
        where: { runId },
        _count: { _all: true },
        _sum: { candidatesFound: true },
      }),
      this.prisma.client.discoveryTask.findMany({
        where: { runId, lastErrorCode: { not: null }, status: { in: ['FAILED', 'RETRYING'] } },
        orderBy: { lastErrorAt: 'desc' },
        take: 50,
      }),
    ]);

    const totals = emptyTaskCounts();
    const perProvider = new Map<string, { counts: TaskCounts; found: number }>();
    for (const row of grouped) {
      addToCounts(totals, row.status, row._count._all);
      const entry = perProvider.get(row.providerId) ?? { counts: emptyTaskCounts(), found: 0 };
      addToCounts(entry.counts, row.status, row._count._all);
      entry.found += row._sum.candidatesFound ?? 0;
      perProvider.set(row.providerId, entry);
    }

    const meta = new Map((config.providers ?? []).map((p) => [p.id, p]));
    const providers: ProviderProgress[] = [...perProvider.entries()].map(([providerId, entry]) => ({
      providerId,
      displayName: meta.get(providerId)?.displayName ?? providerId,
      attribution: meta.get(providerId)?.attribution ?? null,
      tasks: entry.counts,
      candidatesFound: entry.found,
      errors: failing
        .filter((task) => task.providerId === providerId)
        .map((task) => ({
          taskId: task.id,
          keyword: task.keyword,
          code: task.lastErrorCode ?? 'UNKNOWN',
          message: task.lastErrorMessage ?? '',
          attempts: task.attempts,
          retryable: task.lastErrorRetryable ?? false,
          at: (task.lastErrorAt ?? task.updatedAt).toISOString(),
        })),
    }));

    const finished = totals.succeeded + totals.failed + totals.cancelled;
    const percent =
      totals.total > 0
        ? Math.round((finished / totals.total) * 100)
        : TERMINAL.includes(run.status)
          ? 100
          : 0;

    return {
      runId: run.id,
      status: run.status,
      cancelRequested: run.cancelRequestedAt !== null,
      percent,
      planned: run.plannedAt !== null,
      error: config.planError ?? null,
      skippedProviders: config.skippedProviders ?? [],
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      stats: toRun(run, totals).stats,
      tasks: totals,
      providers,
    };
  }

  /**
   * Cooperative cancellation: queued work is cancelled immediately; running tasks stop at
   * their next page boundary (the worker checks cancelRequestedAt). Partial results are kept.
   */
  async cancel(workspace: WorkspaceContext, runId: string): Promise<Run> {
    const updated = await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`run:${runId}`}, 0))`;
      const run = await tx.searchRun.findFirst({ where: { id: runId, workspaceId: workspace.id } });
      if (!run) throw new NotFoundException('Run not found');
      if (TERMINAL.includes(run.status)) {
        throw new ConflictException(`Run already finished (${run.status})`);
      }

      const now = new Date();
      await tx.discoveryTask.updateMany({
        where: { runId, status: { in: ['QUEUED', 'RETRYING'] } },
        data: { status: 'CANCELLED', finishedAt: now },
      });
      const stillRunning = await tx.discoveryTask.count({ where: { runId, status: 'RUNNING' } });

      return tx.searchRun.update({
        where: { id: runId },
        data: {
          cancelRequestedAt: run.cancelRequestedAt ?? now,
          // Nothing executing → finish now. Otherwise the worker finalizes when it drains.
          ...(stillRunning === 0 ? { status: 'CANCELLED' as const, finishedAt: now } : {}),
        },
      });
    });
    return (await this.toRuns([updated]))[0]!;
  }

  async results(
    workspace: WorkspaceContext,
    runId: string,
    query: PaginationQuery,
  ): Promise<DiscoveryResultListResponse> {
    await this.findRun(workspace, runId);
    const rows = await this.prisma.client.discoveryResult.findMany({
      where: {
        runId,
        workspaceId: workspace.id,
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: { company: { include: { _count: { select: { sources: true } } } } },
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        outcome: row.outcome,
        providerId: row.providerId,
        keywords: row.keywords,
        matchScore: row.matchScore,
        matchReasons: Array.isArray(row.matchReasons) ? (row.matchReasons as string[]) : [],
        createdAt: row.createdAt.toISOString(),
        company: toCompanySummary(row.company),
      })),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }
}

export function assertValidIdempotencyKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) {
    throw new BadRequestException('Idempotency-Key must be 1-128 characters of [A-Za-z0-9._-]');
  }
  return key;
}
