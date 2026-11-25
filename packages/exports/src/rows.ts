import type { Prisma, PrismaClient } from '@jobfinder/database';
import {
  companyWhere,
  HR_CATEGORIES,
  jobWhere,
  type CompanyFilters,
  type JobFilters,
} from './queries';
import type { Cell } from './sanitize';

export interface ExportColumn<T> {
  header: string;
  /** Excel column width in characters. */
  width: number;
  value: (row: T) => Cell;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const label = (value: string | null | undefined) =>
  value ? value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ') : null;

// ---------------------------------------------------------------- companies

export interface CompanyExportRow {
  name: string;
  industries: string[];
  city: string | null;
  website: string | null;
  websiteStatus: string;
  hrEmail: string | null;
  emailStatus: string;
  careersUrl: string | null;
  linkedin: string | null;
  openJobs: number;
  totalJobs: number;
  sourceUrl: string | null;
  lastVerified: Date | null;
}

export const COMPANY_COLUMNS: ExportColumn<CompanyExportRow>[] = [
  { header: 'Company name', width: 32, value: (r) => r.name },
  { header: 'Industry', width: 24, value: (r) => r.industries.join('; ') },
  { header: 'City', width: 16, value: (r) => r.city },
  { header: 'Website', width: 34, value: (r) => r.website },
  { header: 'Website verification status', width: 22, value: (r) => label(r.websiteStatus) },
  { header: 'HR email', width: 30, value: (r) => r.hrEmail },
  { header: 'Email verification status', width: 22, value: (r) => label(r.emailStatus) },
  { header: 'Careers page', width: 36, value: (r) => r.careersUrl },
  { header: 'LinkedIn URL', width: 40, value: (r) => r.linkedin },
  {
    header: 'Hiring status',
    width: 14,
    value: (r) => (r.openJobs > 0 ? 'Hiring' : r.totalJobs > 0 ? 'Not hiring' : 'Unknown'),
  },
  { header: 'Active job count', width: 14, value: (r) => r.openJobs },
  { header: 'Source URL', width: 40, value: (r) => r.sourceUrl },
  { header: 'Last verified', width: 22, value: (r) => iso(r.lastVerified) },
];

export const countCompanies = (prisma: PrismaClient, workspaceId: string, f: CompanyFilters) =>
  prisma.company.count({ where: companyWhere(workspaceId, f) });

/** Pages through the companies of an export in a stable order. */
export async function* readCompanies(
  prisma: PrismaClient,
  workspaceId: string,
  filters: CompanyFilters,
  batchSize: number,
): AsyncGenerator<CompanyExportRow[]> {
  const where = companyWhere(workspaceId, filters);
  for (let skip = 0; ; skip += batchSize) {
    const companies = await prisma.company.findMany({
      where,
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      skip,
      take: batchSize,
      include: {
        _count: { select: { jobs: true } },
        contacts: {
          where: {
            OR: [
              { kind: 'LINKEDIN' },
              {
                kind: 'EMAIL',
                category: { in: [...HR_CATEGORIES] },
                verificationStatus: 'VERIFIED',
              },
            ],
          },
          orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
          take: 10,
        },
        pages: {
          where: { type: { in: ['CAREERS', 'JOBS'] } },
          orderBy: [{ typeConfidence: 'desc' }, { url: 'asc' }],
          take: 1,
        },
        sources: {
          where: { sourceUrl: { not: null } },
          orderBy: { retrievedAt: 'asc' },
          take: 1,
          select: { sourceUrl: true },
        },
        results: {
          select: { run: { select: { project: { select: { industry: true } } } } },
          take: 50,
        },
      },
    });
    if (companies.length === 0) return;
    const open = await prisma.job.groupBy({
      by: ['companyId'],
      where: { companyId: { in: companies.map((c) => c.id) }, status: 'OPEN' },
      _count: { _all: true },
    });
    const openBy = new Map(open.map((g) => [g.companyId, g._count._all]));
    yield companies.map((c): CompanyExportRow => {
      const hr = c.contacts.find((x) => x.kind === 'EMAIL');
      const linkedin = c.contacts.find((x) => x.kind === 'LINKEDIN');
      const seen = [c.lastEnrichedAt, hr?.lastSeenAt].filter((d): d is Date => !!d);
      return {
        name: c.displayName,
        industries: [...new Set(c.results.map((r) => r.run.project.industry))].sort(),
        city: c.city,
        website: c.website,
        websiteStatus: c.websiteStatus,
        hrEmail: hr?.value ?? null,
        // The status of the address itself when there is one, else of the company's email field.
        emailStatus: hr?.verificationStatus ?? c.emailStatus,
        careersUrl: c.pages[0]?.url ?? null,
        linkedin: linkedin?.value ?? null,
        openJobs: openBy.get(c.id) ?? 0,
        totalJobs: c._count.jobs,
        sourceUrl: c.sources[0]?.sourceUrl ?? null,
        lastVerified: seen.length ? new Date(Math.max(...seen.map((d) => d.getTime()))) : null,
      };
    });
    if (companies.length < batchSize) return;
  }
}

// ---------------------------------------------------------------- jobs

export interface JobExportRow {
  companyName: string;
  title: string;
  location: string | null;
  employmentType: string;
  workplaceType: string;
  skills: string[];
  minYears: number | null;
  maxYears: number | null;
  matchScore: number | null;
  status: string;
  publishedAt: Date | null;
  applicationUrl: string | null;
  sourceUrl: string;
  lastVerified: Date;
}

function experience(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (min !== null && max !== null && max !== min) return `${min}-${max} years`;
  return `${min ?? max}+ years`;
}

export const JOB_COLUMNS: ExportColumn<JobExportRow>[] = [
  { header: 'Company name', width: 30, value: (r) => r.companyName },
  { header: 'Job title', width: 38, value: (r) => r.title },
  { header: 'Location', width: 24, value: (r) => r.location },
  {
    header: 'Employment type',
    width: 16,
    value: (r) => (r.employmentType === 'UNKNOWN' ? null : label(r.employmentType)),
  },
  {
    header: 'Workplace type',
    width: 14,
    value: (r) => (r.workplaceType === 'UNKNOWN' ? null : label(r.workplaceType)),
  },
  { header: 'Skills', width: 40, value: (r) => r.skills.join('; ') },
  { header: 'Experience', width: 14, value: (r) => experience(r.minYears, r.maxYears) },
  {
    header: 'Match score',
    width: 12,
    value: (r) => (r.matchScore === null ? null : Math.round(r.matchScore * 10) / 10),
  },
  { header: 'Job status', width: 12, value: (r) => label(r.status) },
  { header: 'Publication date', width: 16, value: (r) => day(r.publishedAt) },
  { header: 'Application URL', width: 44, value: (r) => r.applicationUrl },
  { header: 'Source URL', width: 44, value: (r) => r.sourceUrl },
  { header: 'Last verified', width: 22, value: (r) => iso(r.lastVerified) },
];

const jobInclude = {
  company: { select: { displayName: true, city: true } },
  skills: { orderBy: [{ kind: 'asc' as const }, { name: 'asc' as const }], take: 30 },
} satisfies Prisma.JobInclude;

type JobRecord = Prisma.JobGetPayload<{ include: typeof jobInclude }>;

const toJobRow = (j: JobRecord, matchScore: number | null): JobExportRow => ({
  companyName: j.company.displayName,
  title: j.title,
  location: j.location ?? j.company.city,
  employmentType: j.employmentType,
  workplaceType: j.workplaceType,
  skills: j.skills.map((s) => s.name),
  minYears: j.minYearsExperience,
  maxYears: j.maxYearsExperience,
  matchScore,
  status: j.status,
  publishedAt: j.publishedAt,
  applicationUrl: j.applicationUrl,
  sourceUrl: j.sourceUrl,
  lastVerified: j.lastSeenAt,
});

/** With a project the jobs are that project's MATCHES (best first); otherwise the jobs table. */
function matchWhere(workspaceId: string, f: JobFilters): Prisma.JobMatchWhereInput {
  const { projectId: _project, minMatchScore, ...jobFilters } = f;
  return {
    workspaceId,
    projectId: f.projectId!,
    ...(minMatchScore !== undefined ? { score: { gte: minMatchScore } } : {}),
    job: jobWhere(workspaceId, jobFilters),
  };
}

export function countJobs(prisma: PrismaClient, workspaceId: string, f: JobFilters) {
  return f.projectId
    ? prisma.jobMatch.count({ where: matchWhere(workspaceId, f) })
    : prisma.job.count({ where: jobWhere(workspaceId, f) });
}

export async function* readJobs(
  prisma: PrismaClient,
  workspaceId: string,
  filters: JobFilters,
  batchSize: number,
): AsyncGenerator<JobExportRow[]> {
  if (filters.projectId) {
    const where = matchWhere(workspaceId, filters);
    for (let skip = 0; ; skip += batchSize) {
      const matches = await prisma.jobMatch.findMany({
        where,
        orderBy: [{ score: 'desc' }, { id: 'desc' }],
        skip,
        take: batchSize,
        include: { job: { include: jobInclude } },
      });
      if (matches.length === 0) return;
      yield matches.map((m) => toJobRow(m.job, m.score));
      if (matches.length < batchSize) return;
    }
  }

  const where = jobWhere(workspaceId, filters);
  for (let skip = 0; ; skip += batchSize) {
    const jobs = await prisma.job.findMany({
      where,
      orderBy: [{ company: { displayName: 'asc' } }, { title: 'asc' }, { id: 'asc' }],
      skip,
      take: batchSize,
      include: {
        ...jobInclude,
        matches: { orderBy: { score: 'desc' }, take: 1, select: { score: true } },
      },
    });
    if (jobs.length === 0) return;
    yield jobs.map((j) => toJobRow(j, j.matches[0]?.score ?? null));
    if (jobs.length < batchSize) return;
  }
}
