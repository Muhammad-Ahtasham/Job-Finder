import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SearchProject, SearchRun } from '@jobfinder/database';
import {
  ACTIVE_RUN_STATUSES,
  type CreateProjectRequest,
  type Project,
  type ProjectListResponse,
  type UpdateProjectRequest,
} from '@jobfinder/contracts';
import { isValidCountryCode } from '@jobfinder/discovery';
import { isUniqueViolation } from '../common/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { RunsService } from '../runs/runs.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RunsService,
  ) {}

  private assertCountry(country: string): void {
    if (!isValidCountryCode(country)) {
      throw new BadRequestException(`"${country}" is not a valid ISO 3166-1 alpha-2 country code`);
    }
  }

  async create(
    workspace: WorkspaceContext,
    userId: string,
    input: CreateProjectRequest,
  ): Promise<Project> {
    this.assertCountry(input.country);
    try {
      const project = await this.prisma.client.searchProject.create({
        data: { ...input, workspaceId: workspace.id, createdById: userId },
      });
      return this.toProject(project, null);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A project with this name already exists in the workspace');
      }
      throw error;
    }
  }

  async list(workspace: WorkspaceContext): Promise<ProjectListResponse> {
    const projects = await this.prisma.client.searchProject.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { id: 'desc' },
    });
    const lastRuns = await this.lastRuns(
      workspace.id,
      projects.map((p) => p.id),
    );
    return { items: projects.map((p) => this.toProject(p, lastRuns.get(p.id) ?? null)) };
  }

  async get(workspace: WorkspaceContext, id: string): Promise<Project> {
    const project = await this.find(workspace, id);
    const lastRuns = await this.lastRuns(workspace.id, [id]);
    return this.toProject(project, lastRuns.get(id) ?? null);
  }

  async update(
    workspace: WorkspaceContext,
    id: string,
    input: UpdateProjectRequest,
  ): Promise<Project> {
    await this.find(workspace, id);
    if (input.country) this.assertCountry(input.country);
    try {
      // Editing never affects runs in flight: each run snapshots the project's config.
      const project = await this.prisma.client.searchProject.update({ where: { id }, data: input });
      const lastRuns = await this.lastRuns(workspace.id, [id]);
      return this.toProject(project, lastRuns.get(id) ?? null);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A project with this name already exists in the workspace');
      }
      throw error;
    }
  }

  /** Deletes the project and its runs/results. Discovered companies are kept (workspace data). */
  async delete(workspace: WorkspaceContext, id: string): Promise<void> {
    await this.find(workspace, id);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`project:${id}`}, 0))`;
      const active = await tx.searchRun.findFirst({
        where: { projectId: id, status: { in: ACTIVE_RUN_STATUSES } },
        select: { id: true },
      });
      if (active) {
        throw new ConflictException('Cancel the active discovery run before deleting this project');
      }
      await tx.searchProject.delete({ where: { id } });
    });
  }

  private async find(workspace: WorkspaceContext, id: string): Promise<SearchProject> {
    const project = await this.prisma.client.searchProject.findFirst({
      where: { id, workspaceId: workspace.id },
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  private async lastRuns(workspaceId: string, projectIds: string[]) {
    if (projectIds.length === 0)
      return new Map<string, Awaited<ReturnType<RunsService['toRuns']>>[number]>();
    const latest: SearchRun[] = await this.prisma.client.searchRun.findMany({
      where: { workspaceId, projectId: { in: projectIds } },
      orderBy: { id: 'desc' },
      distinct: ['projectId'],
    });
    const dtos = await this.runs.toRuns(latest);
    return new Map(dtos.map((run) => [run.projectId, run]));
  }

  private toProject(project: SearchProject, lastRun: Project['lastRun']): Project {
    return {
      id: project.id,
      name: project.name,
      country: project.country,
      city: project.city,
      industry: project.industry,
      keywords: project.keywords,
      targetRoles: project.targetRoles,
      targetSkills: project.targetSkills,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      lastRun,
    };
  }
}
