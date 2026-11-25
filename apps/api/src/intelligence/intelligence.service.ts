import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jobfinder/database';
import {
  validWeights,
  type JobDetail,
  type JobHistoryResponse,
  type JobSearchQuery,
  type JobSearchResponse,
  type MatchListQuery,
  type MatchListResponse,
  type MatchPreferences,
  type UpdateMatchPreferencesRequest,
} from '@jobfinder/contracts';
import { normalizeSkill } from '@jobfinder/intelligence';
import { PrismaService } from '../prisma/prisma.service';
import { MatchQueueService } from '../queue/match-queue.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import {
  JOB_DETAIL_INCLUDE,
  toJobDetail,
  toMatch,
  toObservation,
  toPreferences,
} from './intelligence.mapper';

@Injectable()
export class IntelligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: MatchQueueService,
  ) {}

  // ---------------------------------------------------------------- jobs

  async searchJobs(workspace: WorkspaceContext, query: JobSearchQuery): Promise<JobSearchResponse> {
    const where: Prisma.JobWhereInput = {
      workspaceId: workspace.id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.seniority ? { seniority: query.seniority } : {}),
      ...(query.employmentType ? { employmentType: query.employmentType } : {}),
      ...(query.workplaceType ? { workplaceType: query.workplaceType } : {}),
      ...(query.roleCategory ? { roleCategory: query.roleCategory } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { normalizedTitle: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.skill
        ? { skills: { some: { skillKey: normalizeSkill(query.skill)?.key ?? '\u0000' } } }
        : {}),
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
    };
    const rows = await this.prisma.client.job.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: JOB_DETAIL_INCLUDE,
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toJobDetail),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }

  async getJob(workspace: WorkspaceContext, id: string): Promise<JobDetail> {
    const job = await this.prisma.client.job.findFirst({
      where: { id, workspaceId: workspace.id },
      include: JOB_DETAIL_INCLUDE,
    });
    if (!job) throw new NotFoundException('Job not found');
    return toJobDetail(job);
  }

  async history(
    workspace: WorkspaceContext,
    id: string,
    query: { limit: number; cursor?: string },
  ): Promise<JobHistoryResponse> {
    const job = await this.prisma.client.job.findFirst({
      where: { id, workspaceId: workspace.id },
      select: { id: true, status: true, firstSeenAt: true, lastSeenAt: true },
    });
    if (!job) throw new NotFoundException('Job not found');
    const rows = await this.prisma.client.jobObservation.findMany({
      where: { jobId: id, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      jobId: job.id,
      status: job.status,
      firstSeenAt: job.firstSeenAt.toISOString(),
      lastSeenAt: job.lastSeenAt.toISOString(),
      items: page.map(toObservation),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }

  // ---------------------------------------------------------------- project matches

  private async project(workspace: WorkspaceContext, id: string) {
    const project = await this.prisma.client.searchProject.findFirst({
      where: { id, workspaceId: workspace.id },
      include: { matchPreference: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async matches(
    workspace: WorkspaceContext,
    projectId: string,
    query: MatchListQuery,
  ): Promise<MatchListResponse> {
    const project = await this.project(workspace, projectId);
    const minScore = query.minScore ?? project.matchPreference?.minScore ?? 0;

    let cursorWhere: Prisma.JobMatchWhereInput = {};
    if (query.cursor) {
      const [rawScore, id] = query.cursor.split('|');
      const score = Number(rawScore);
      if (!id || !Number.isFinite(score) || !/^[0-9a-f-]{36}$/i.test(id)) {
        throw new BadRequestException('Invalid cursor');
      }
      cursorWhere = { OR: [{ score: { lt: score } }, { score, id: { lt: id } }] };
    }
    const rows = await this.prisma.client.jobMatch.findMany({
      where: {
        projectId,
        workspaceId: workspace.id,
        score: { gte: minScore },
        job: { status: query.status },
        ...cursorWhere,
      },
      orderBy: [{ score: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: { evidence: true, job: { include: JOB_DETAIL_INCLUDE } },
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];

    const companyScope: Prisma.CompanyWhereInput = {
      status: 'ACTIVE',
      OR: [
        { results: { some: { run: { projectId } } } },
        { mergedFrom: { some: { results: { some: { run: { projectId } } } } } },
      ],
    };
    const pendingJobs = await this.prisma.client.job.count({
      where: {
        workspaceId: workspace.id,
        status: 'OPEN',
        company: companyScope,
        matches: { none: { projectId } },
      },
    });
    return {
      projectId,
      items: page.map(toMatch),
      nextCursor: rows.length > query.limit && last ? `${last.score}|${last.id}` : null,
      pendingJobs,
    };
  }

  async refreshMatches(
    workspace: WorkspaceContext,
    projectId: string,
  ): Promise<{ queued: boolean }> {
    await this.project(workspace, projectId);
    return { queued: await this.queue.enqueue(projectId) };
  }

  // ---------------------------------------------------------------- matching preferences

  async preferences(workspace: WorkspaceContext, projectId: string): Promise<MatchPreferences> {
    return toPreferences((await this.project(workspace, projectId)).matchPreference);
  }

  /** Updates the preferences, bumps their version and queues a re-match (weights, skills, ... all feed the score). */
  async updatePreferences(
    workspace: WorkspaceContext,
    projectId: string,
    input: UpdateMatchPreferencesRequest,
  ): Promise<MatchPreferences> {
    const project = await this.project(workspace, projectId);
    const current = toPreferences(project.matchPreference);
    const weights = { ...current.weights, ...input.weights };
    if (!validWeights(weights))
      throw new BadRequestException('At least one weight must be greater than 0');

    const data = {
      roleWeight: weights.role,
      skillsWeight: weights.skills,
      experienceWeight: weights.experience,
      locationWeight: weights.location,
      ...(input.yearsExperience !== undefined ? { yearsExperience: input.yearsExperience } : {}),
      ...(input.seniorities ? { seniorities: input.seniorities } : {}),
      ...(input.workplaceTypes ? { workplaceTypes: input.workplaceTypes } : {}),
      ...(input.locations ? { locations: input.locations } : {}),
      ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
    };
    const row = await this.prisma.client.matchPreference.upsert({
      where: { projectId },
      create: { projectId, workspaceId: workspace.id, ...data },
      update: { ...data, version: { increment: 1 } },
    });
    await this.queue.enqueue(projectId);
    return toPreferences(row);
  }
}
