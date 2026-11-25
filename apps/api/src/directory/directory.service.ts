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
import { normalizeSkill } from '@jobfinder/intelligence';
import { PrismaService } from '../prisma/prisma.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';

/** Email categories that count as "published HR email". */
const HR_CATEGORIES = ['HR', 'CAREERS', 'RECRUITMENT'] as const;
const EXPORT_LIMIT = 5000;

const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const });

/** Companies found by a project (directly, or through a company merged into them). */
const foundByProject = (projectId: string): Prisma.CompanyWhereInput => ({
  OR: [
    { results: { some: { run: { projectId } } } },
    { mergedFrom: { some: { results: { some: { run: { projectId } } } } } },
  ],
});

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
      this.db.company.count({ where: { ...base, ...this.hrEmailWhere() } }),
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

  private hrEmailWhere(): Prisma.CompanyWhereInput {
    return {
      contacts: {
        some: {
          kind: 'EMAIL',
          category: { in: [...HR_CATEGORIES] },
          verificationStatus: 'VERIFIED',
        },
      },
    };
  }

  private companyWhere(
    workspace: WorkspaceContext,
    q: Partial<CompanyDirectoryQuery>,
  ): Prisma.CompanyWhereInput {
    const and: Prisma.CompanyWhereInput[] = [];
    if (q.q) and.push({ OR: [{ displayName: contains(q.q) }, { domain: contains(q.q) }] });
    if (q.city) and.push({ city: contains(q.city) });
    if (q.industry) {
      and.push({
        results: {
          some: { run: { project: { industry: { equals: q.industry, mode: 'insensitive' } } } },
        },
      });
    }
    if (q.websiteStatus) and.push({ websiteStatus: q.websiteStatus });
    if (q.hasWebsite !== undefined) and.push({ website: q.hasWebsite ? { not: null } : null });
    if (q.hasHrEmail !== undefined)
      and.push(q.hasHrEmail ? this.hrEmailWhere() : { NOT: this.hrEmailWhere() });
    if (q.hasCareersPage !== undefined) {
      const has: Prisma.CompanyWhereInput = { careersStatus: { in: ['VERIFIED', 'UNVERIFIED'] } };
      and.push(q.hasCareersPage ? has : { NOT: has });
    }
    if (q.hiring !== undefined) {
      const open: Prisma.CompanyWhereInput = { jobs: { some: { status: 'OPEN' } } };
      and.push(q.hiring ? open : { NOT: open });
    }
    if (q.projectId) and.push(foundByProject(q.projectId));
    return { workspaceId: workspace.id, status: 'ACTIVE', AND: and };
  }

  async companies(
    workspace: WorkspaceContext,
    q: CompanyDirectoryQuery,
  ): Promise<CompanyDirectoryResponse> {
    await this.assertProject(workspace, q.projectId);
    const where = this.companyWhere(workspace, q);
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

  private jobWhere(workspace: WorkspaceContext, q: JobDirectoryQuery): Prisma.JobWhereInput {
    const and: Prisma.JobWhereInput[] = [];
    if (q.q) {
      and.push({
        OR: [
          { title: contains(q.q) },
          { normalizedTitle: contains(q.q) },
          { company: { displayName: contains(q.q) } },
        ],
      });
    }
    if (q.city)
      and.push({ OR: [{ location: contains(q.city) }, { company: { city: contains(q.city) } }] });
    if (q.industry) {
      and.push({
        company: {
          results: {
            some: { run: { project: { industry: { equals: q.industry, mode: 'insensitive' } } } },
          },
        },
      });
    }
    if (q.role)
      and.push({
        OR: [
          { roleCategory: q.role },
          { title: contains(q.role) },
          { normalizedTitle: contains(q.role) },
        ],
      });
    if (q.skill)
      and.push({ skills: { some: { skillKey: normalizeSkill(q.skill)?.key ?? '\u0000' } } });
    if (q.projectId) and.push({ company: foundByProject(q.projectId) });
    return {
      workspaceId: workspace.id,
      ...(q.status ? { status: q.status } : {}),
      ...(q.seniority ? { seniority: q.seniority } : {}),
      ...(q.employmentType ? { employmentType: q.employmentType } : {}),
      ...(q.workplaceType ? { workplaceType: q.workplaceType } : {}),
      ...(q.companyId ? { companyId: q.companyId } : {}),
      AND: and,
    };
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
    const where = this.jobWhere(workspace, q);
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

  // ---------------------------------------------------------------- exports

  async exportCompanies(workspace: WorkspaceContext, q: CompanyDirectoryQuery): Promise<string> {
    const res = await this.companies(workspace, { ...q, page: 1, pageSize: 100 });
    const rows = [...res.items];
    for (let page = 2; page <= res.totalPages && rows.length < EXPORT_LIMIT; page++) {
      rows.push(...(await this.companies(workspace, { ...q, page, pageSize: 100 })).items);
    }
    return toCsv(
      [
        'Company',
        'Industry',
        'City',
        'Country',
        'Website',
        'Website status',
        'HR email',
        'Careers page',
        'LinkedIn',
        'Hiring',
        'Open jobs',
        'Total jobs',
      ],
      rows
        .slice(0, EXPORT_LIMIT)
        .map((c) => [
          c.displayName,
          c.industries.join('; '),
          c.city,
          c.country,
          c.website,
          c.websiteStatus,
          c.hrEmail,
          c.careersUrl,
          c.linkedin,
          c.hiring ? 'yes' : 'no',
          c.openJobs,
          c.jobCount,
        ]),
    );
  }

  async exportJobs(workspace: WorkspaceContext, q: JobDirectoryQuery): Promise<string> {
    const res = await this.jobs(workspace, { ...q, page: 1, pageSize: 100 });
    const rows = [...res.items];
    for (let page = 2; page <= res.totalPages && rows.length < EXPORT_LIMIT; page++) {
      rows.push(...(await this.jobs(workspace, { ...q, page, pageSize: 100 })).items);
    }
    return toCsv(
      [
        'Job title',
        'Company',
        'City',
        'Skills',
        'Min years',
        'Max years',
        'Match score',
        'Status',
        'Application link',
        'Published',
      ],
      rows
        .slice(0, EXPORT_LIMIT)
        .map((j) => [
          j.title,
          j.companyName,
          j.city,
          j.skills.map((s) => s.name).join('; '),
          j.minYears,
          j.maxYears,
          j.matchScore,
          j.status,
          j.applicationUrl,
          j.publishedAt,
        ]),
    );
  }
}

/** RFC 4180 CSV; cells that a spreadsheet would run as a formula are neutralised. */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const cell = (value: string | number | null): string => {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text) && typeof value === 'string') text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
