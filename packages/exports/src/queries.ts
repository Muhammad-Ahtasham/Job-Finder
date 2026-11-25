import type { Prisma } from '@jobfinder/database';
import { normalizeSkill } from '@jobfinder/intelligence';

/**
 * The company and job filters, shared by the tables (API) and by exports (worker): an export
 * of "what the table shows" is guaranteed to use the same rules as the table.
 */

/** Email categories that count as a published HR email. */
export const HR_CATEGORIES = ['HR', 'CAREERS', 'RECRUITMENT'] as const;

export interface CompanyFilters {
  q?: string;
  city?: string;
  industry?: string;
  websiteStatus?: 'MISSING' | 'UNVERIFIED' | 'VERIFIED' | 'FAILED';
  hasWebsite?: boolean;
  hasHrEmail?: boolean;
  hasCareersPage?: boolean;
  hiring?: boolean;
  projectId?: string;
}

export interface JobFilters {
  q?: string;
  city?: string;
  industry?: string;
  role?: string;
  status?: 'OPEN' | 'CLOSED' | 'EXPIRED' | 'UNKNOWN';
  skill?: string;
  seniority?: string;
  employmentType?: string;
  workplaceType?: string;
  companyId?: string;
  projectId?: string;
  minMatchScore?: number;
}

const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const });

export const hrEmailWhere = (): Prisma.CompanyWhereInput => ({
  contacts: {
    some: {
      kind: 'EMAIL',
      category: { in: [...HR_CATEGORIES] },
      verificationStatus: 'VERIFIED',
    },
  },
});

/** Companies found by a project (directly, or through a company merged into them). */
export const foundByProject = (projectId: string): Prisma.CompanyWhereInput => ({
  OR: [
    { results: { some: { run: { projectId } } } },
    { mergedFrom: { some: { results: { some: { run: { projectId } } } } } },
  ],
});

export function companyWhere(workspaceId: string, q: CompanyFilters): Prisma.CompanyWhereInput {
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
  if (q.hasHrEmail !== undefined) and.push(q.hasHrEmail ? hrEmailWhere() : { NOT: hrEmailWhere() });
  if (q.hasCareersPage !== undefined) {
    const has: Prisma.CompanyWhereInput = { careersStatus: { in: ['VERIFIED', 'UNVERIFIED'] } };
    and.push(q.hasCareersPage ? has : { NOT: has });
  }
  if (q.hiring !== undefined) {
    const open: Prisma.CompanyWhereInput = { jobs: { some: { status: 'OPEN' } } };
    and.push(q.hiring ? open : { NOT: open });
  }
  if (q.projectId) and.push(foundByProject(q.projectId));
  return { workspaceId, status: 'ACTIVE', AND: and };
}

export function jobWhere(workspaceId: string, q: JobFilters): Prisma.JobWhereInput {
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
  if (q.city) {
    and.push({ OR: [{ location: contains(q.city) }, { company: { city: contains(q.city) } }] });
  }
  if (q.industry) {
    and.push({
      company: {
        results: {
          some: { run: { project: { industry: { equals: q.industry, mode: 'insensitive' } } } },
        },
      },
    });
  }
  if (q.role) {
    and.push({
      OR: [
        { roleCategory: q.role },
        { title: contains(q.role) },
        { normalizedTitle: contains(q.role) },
      ],
    });
  }
  if (q.skill) {
    and.push({ skills: { some: { skillKey: normalizeSkill(q.skill)?.key ?? '\u0000' } } });
  }
  if (q.projectId) and.push({ company: foundByProject(q.projectId) });
  return {
    workspaceId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.seniority ? { seniority: q.seniority as never } : {}),
    ...(q.employmentType ? { employmentType: q.employmentType as never } : {}),
    ...(q.workplaceType ? { workplaceType: q.workplaceType as never } : {}),
    ...(q.companyId ? { companyId: q.companyId } : {}),
    AND: and,
  };
}
