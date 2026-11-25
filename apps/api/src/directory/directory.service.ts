import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jobfinder/database';
import type {
  CompanyDirectoryQuery,
  CompanyDirectoryResponse,
  CompanyRow,
  DashboardSummary,
  DirectoryFacets,
  JobDirectoryQuery,
  JobDirectoryResponse,
  JobRow,
} from '@jobfinder/contracts';
import { companyWhere, HR_CATEGORIES, hrEmailWhere, jobWhere } from '@jobfinder/exports';
import { PrismaService } from '../prisma/prisma.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';

@Injectable()
export class DirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.client;
  }

  // ---------------------------------------------------------------- dashboard

  async summary(workspace: WorkspaceContext): Promise<DashboardSummary> {
    const base: Prisma.CompanyWhereInput = { workspaceId: workspace.id, status: 'ACTIVE' };
    const [
      total,
      verifiedWebsites,
      withCareersPage,
      withHrEmail,
      hiring,
      openJobs,
      matched,
      projects,
      runs,
    ] = await Promise.all([
      this.db.company.count({ where: base }),
      this.db.company.count({ where: { ...base, websiteStatus: 'VERIFIED' } }),
      this.db.company.count({
        where: { ...base, careersStatus: { in: ['VERIFIED', 'UNVERIFIED'] } },
      }),
      this.db.company.count({ where: { ...base, ...hrEmailWhere() } }),
      this.db.company.count({ where: { ...base, jobs: { some: { status: 'OPEN' } } } }),
      this.db.job.count({ where: { workspaceId: workspace.id, status: 'OPEN' } }),
      this.db.job.count({
        where: {
          workspaceId: workspace.id,
          status: 'OPEN',
          matches: { some: { score: { gt: 0 } } },
        },
      }),
      this.db.searchProject.count({ where: { workspaceId: workspace.id } }),
      this.db.searchRun.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { id: 'desc' },
        take: 8,
        include: { project: { select: { name: true } } },
      }),
    ]);
    return {
      companies: { total, verifiedWebsites, withCareersPage, withHrEmail, hiring },
      jobs: { open: openJobs, matched },
      projects,
      recentRuns: runs.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        projectName: r.project.name,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        candidatesFound: r.candidatesFound,
        companiesCreated: r.companiesCreated,
        companiesMatched: r.companiesMatched,
      })),
    };
  }

  async facets(workspace: WorkspaceContext): Promise<DirectoryFacets> {
    const [cities, industries, roles] = await Promise.all([
      this.db.company.findMany({
        where: { workspaceId: workspace.id, status: 'ACTIVE', city: { not: null } },
        distinct: ['city'],
        select: { city: true },
        orderBy: { city: 'asc' },
        take: 300,
      }),
      this.db.searchProject.findMany({
        where: { workspaceId: workspace.id },
        distinct: ['industry'],
        select: { industry: true },
        orderBy: { industry: 'asc' },
        take: 300,
      }),
      this.db.job.findMany({
        where: { workspaceId: workspace.id, roleCategory: { not: null } },
        distinct: ['roleCategory'],
        select: { roleCategory: true },
        orderBy: { roleCategory: 'asc' },
        take: 100,
      }),
    ]);
    return {
      cities: cities.map((c) => c.city!),
      industries: industries.map((i) => i.industry),
      roleCategories: roles.map((r) => r.roleCategory!),
    };
  }

  // ---------------------------------------------------------------- companies

  async companies(
    workspace: WorkspaceContext,
    q: CompanyDirectoryQuery,
  ): Promise<CompanyDirectoryResponse> {
    await this.assertProject(workspace, q.projectId);
    const where = companyWhere(workspace.id, q);
    const dir = q.order;
    const orderBy: Prisma.CompanyOrderByWithRelationInput[] =
      q.sort === 'name'
        ? [{ displayName: dir }]
        : q.sort === 'city'
          ? [{ city: { sort: dir, nulls: 'last' } }]
          : q.sort === 'websiteStatus'
            ? [{ websiteStatus: dir }]
            : q.sort === 'jobCount'
              ? [{ jobs: { _count: dir } }]
              : [{ createdAt: dir }];
    orderBy.push({ id: 'desc' });

    const [total, rows] = await Promise.all([
      this.db.company.count({ where }),
      this.db.company.findMany({
        where,
        orderBy,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: this.companyRowInclude(),
      }),
    ]);
    const open = await this.openJobCounts(rows.map((r) => r.id));
    return {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
      items: rows.map((r) => this.toCompanyRow(r, open.get(r.id) ?? 0)),
    };
  }

  private companyRowInclude() {
    return {
      _count: { select: { jobs: true } },
      contacts: {
        where: {
          OR: [
            { kind: 'LINKEDIN' as const },
            {
              kind: 'EMAIL' as const,
              category: { in: [...HR_CATEGORIES] },
              verificationStatus: 'VERIFIED' as const,
            },
          ],
        },
        orderBy: [{ confidence: 'desc' as const }, { id: 'asc' as const }],
        take: 10,
      },
      pages: {
        where: { type: { in: ['CAREERS' as const, 'JOBS' as const] } },
        orderBy: [{ typeConfidence: 'desc' as const }, { url: 'asc' as const }],
        take: 1,
      },
      results: {
        select: { run: { select: { project: { select: { industry: true } } } } },
        take: 50,
      },
    };
  }

  private async openJobCounts(companyIds: string[]): Promise<Map<string, number>> {
    if (companyIds.length === 0) return new Map();
    const groups = await this.db.job.groupBy({
      by: ['companyId'],
      where: { companyId: { in: companyIds }, status: 'OPEN' },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.companyId, g._count._all]));
  }

  private toCompanyRow(
    c: Prisma.CompanyGetPayload<{ include: ReturnType<DirectoryService['companyRowInclude']> }>,
    openJobs: number,
  ): CompanyRow {
    const hr = c.contacts.find((x) => x.kind === 'EMAIL');
    const linkedin = c.contacts.find((x) => x.kind === 'LINKEDIN');
    return {
      id: c.id,
      displayName: c.displayName,
      industries: [...new Set(c.results.map((r) => r.run.project.industry))].sort(),
      city: c.city,
      country: c.country,
      website: c.website,
      websiteStatus: c.websiteStatus,
      hrEmail: hr?.value ?? null,
      emailStatus: c.emailStatus,
      careersStatus: c.careersStatus,
      careersUrl: c.pages[0]?.url ?? null,
      linkedin: linkedin?.value ?? null,
      hiring: openJobs > 0,
      openJobs,
      jobCount: c._count.jobs,
      createdAt: c.createdAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------- jobs

  private async assertProject(workspace: WorkspaceContext, projectId?: string) {
    if (!projectId) return;
    const found = await this.db.searchProject.findFirst({
      where: { id: projectId, workspaceId: workspace.id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Project not found');
  }

  private jobInclude(projectId?: string) {
    return {
      company: { select: { displayName: true, city: true } },
      skills: { orderBy: [{ kind: 'asc' as const }, { name: 'asc' as const }], take: 12 },
      matches: {
        where: projectId ? { projectId } : {},
        orderBy: { score: 'desc' as const },
        take: 1,
        select: { score: true, confidence: true, projectId: true },
      },
    };
  }

  async jobs(workspace: WorkspaceContext, q: JobDirectoryQuery): Promise<JobDirectoryResponse> {
    await this.assertProject(workspace, q.projectId);
    if (q.sort === 'match' && !q.projectId) {
      throw new BadRequestException('Sorting by match score needs a projectId');
    }
    const where = jobWhere(workspace.id, q);
    const include = this.jobInclude(q.projectId);
    const skip = (q.page - 1) * q.pageSize;
    type JobRecord = Prisma.JobGetPayload<{ include: ReturnType<DirectoryService['jobInclude']> }>;
    let rows: JobRecord[];
    let total: number;

    if (q.projectId && (q.sort === 'match' || q.minMatchScore !== undefined)) {
      // Matches drive the page: they are the only way to order/filter by a project's score.
      const matchWhere: Prisma.JobMatchWhereInput = {
        projectId: q.projectId,
        workspaceId: workspace.id,
        ...(q.minMatchScore !== undefined ? { score: { gte: q.minMatchScore } } : {}),
        job: where,
      };
      const [count, matches] = await Promise.all([
        this.db.jobMatch.count({ where: matchWhere }),
        this.db.jobMatch.findMany({
          where: matchWhere,
          orderBy:
            q.sort === 'match' ? [{ score: q.order }, { id: 'desc' }] : this.matchJobOrder(q),
          skip,
          take: q.pageSize,
          include: { job: { include } },
        }),
      ]);
      total = count;
      rows = matches.map((m) => m.job);
    } else {
      const withScore: Prisma.JobWhereInput =
        q.minMatchScore !== undefined
          ? { ...where, matches: { some: { score: { gte: q.minMatchScore } } } }
          : where;
      const [count, jobs] = await Promise.all([
        this.db.job.count({ where: withScore }),
        this.db.job.findMany({
          where: withScore,
          orderBy: this.jobOrder(q),
          skip,
          take: q.pageSize,
          include,
        }),
      ]);
      total = count;
      rows = jobs;
    }
    return {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
      items: rows.map((j) => this.toJobRow(j)),
    };
  }

  private jobOrder(q: JobDirectoryQuery): Prisma.JobOrderByWithRelationInput[] {
    const d = q.order;
    const primary: Prisma.JobOrderByWithRelationInput =
      q.sort === 'title'
        ? { title: d }
        : q.sort === 'company'
          ? { company: { displayName: d } }
          : q.sort === 'city'
            ? { location: { sort: d, nulls: 'last' } }
            : q.sort === 'status'
              ? { status: d }
              : { publishedAt: { sort: d, nulls: 'last' } };
    return [primary, { id: 'desc' }];
  }

  private matchJobOrder(q: JobDirectoryQuery): Prisma.JobMatchOrderByWithRelationInput[] {
    return [
      ...this.jobOrder(q)
        .slice(0, 1)
        .map((job) => ({ job })),
      { id: 'desc' },
    ];
  }

  private toJobRow(
    j: Prisma.JobGetPayload<{ include: ReturnType<DirectoryService['jobInclude']> }>,
  ): JobRow {
    const match = j.matches[0];
    return {
      id: j.id,
      title: j.title,
      normalizedTitle: j.normalizedTitle,
      companyId: j.companyId,
      companyName: j.company.displayName,
      city: j.location ?? j.company.city,
      location: j.location,
      roleCategory: j.roleCategory,
      seniority: j.seniority,
      workplaceType: j.workplaceType,
      skills: j.skills.map((s) => ({ name: s.name, kind: s.kind })),
      minYears: j.minYearsExperience,
      maxYears: j.maxYearsExperience,
      matchScore: match?.score ?? null,
      matchConfidence: match?.confidence ?? null,
      matchProjectId: match?.projectId ?? null,
      status: j.status,
      applicationUrl: j.applicationUrl,
      sourceUrl: j.sourceUrl,
      publishedAt: j.publishedAt?.toISOString() ?? null,
      analysisState: j.analysisHash ? 'ANALYZED' : 'PENDING',
    };
  }
}
