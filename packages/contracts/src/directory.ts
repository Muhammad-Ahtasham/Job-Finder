import { z } from 'zod';
import { fieldStatusSchema, runStatusSchema } from './discovery';
import { employmentTypeSchema, jobStatusSchema, workplaceTypeSchema } from './jobs';
import { senioritySchema } from './intelligence';

/** "true" / "false" query-string flags. */
const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

const pagingQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  order: z.enum(['asc', 'desc']).default('desc'),
};

const pageMeta = z.object({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

// ---------------------------------------------------------------- dashboard
export const dashboardSummarySchema = z.object({
  companies: z.object({
    total: z.number(),
    verifiedWebsites: z.number(),
    withCareersPage: z.number(),
    withHrEmail: z.number(),
    hiring: z.number(),
  }),
  jobs: z.object({ open: z.number(), matched: z.number() }),
  projects: z.number(),
  recentRuns: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      status: runStatusSchema,
      createdAt: z.string(),
      finishedAt: z.string().nullable(),
      candidatesFound: z.number(),
      companiesCreated: z.number(),
      companiesMatched: z.number(),
    }),
  ),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

// ---------------------------------------------------------------- facets
export const directoryFacetsSchema = z.object({
  cities: z.array(z.string()),
  industries: z.array(z.string()),
  roleCategories: z.array(z.string()),
});
export type DirectoryFacets = z.infer<typeof directoryFacetsSchema>;

// ---------------------------------------------------------------- companies
export const COMPANY_SORTS = ['name', 'city', 'websiteStatus', 'jobCount', 'createdAt'] as const;

export const companyDirectoryQuerySchema = z.object({
  ...pagingQuery,
  sort: z.enum(COMPANY_SORTS).default('createdAt'),
  q: z.string().trim().min(1).max(100).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  industry: z.string().trim().min(1).max(100).optional(),
  websiteStatus: fieldStatusSchema.optional(),
  hasWebsite: flag,
  hasHrEmail: flag,
  hasCareersPage: flag,
  hiring: flag,
  projectId: z.string().uuid().optional(),
});
export type CompanyDirectoryQuery = z.infer<typeof companyDirectoryQuerySchema>;

export const companyRowSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  industries: z.array(z.string()),
  city: z.string().nullable(),
  country: z.string(),
  website: z.string().nullable(),
  websiteStatus: fieldStatusSchema,
  hrEmail: z.string().nullable(),
  emailStatus: fieldStatusSchema,
  careersStatus: fieldStatusSchema,
  careersUrl: z.string().nullable(),
  linkedin: z.string().nullable(),
  hiring: z.boolean(),
  openJobs: z.number(),
  jobCount: z.number(),
  createdAt: z.string(),
});
export type CompanyRow = z.infer<typeof companyRowSchema>;

export const companyDirectoryResponseSchema = pageMeta.extend({
  items: z.array(companyRowSchema),
});
export type CompanyDirectoryResponse = z.infer<typeof companyDirectoryResponseSchema>;

// ---------------------------------------------------------------- jobs
export const JOB_SORTS = ['title', 'company', 'city', 'status', 'publishedAt', 'match'] as const;

export const jobDirectoryQuerySchema = z.object({
  ...pagingQuery,
  sort: z.enum(JOB_SORTS).default('publishedAt'),
  q: z.string().trim().min(1).max(100).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  industry: z.string().trim().min(1).max(100).optional(),
  /** Job role: a role family (roleCategory) or part of the title. */
  role: z.string().trim().min(1).max(100).optional(),
  status: jobStatusSchema.optional(),
  skill: z.string().trim().min(1).max(60).optional(),
  seniority: senioritySchema.optional(),
  employmentType: employmentTypeSchema.optional(),
  workplaceType: workplaceTypeSchema.optional(),
  companyId: z.string().uuid().optional(),
  /** Scores and sorting by match use this project's matches. */
  projectId: z.string().uuid().optional(),
  minMatchScore: z.coerce.number().min(0).max(100).optional(),
});
export type JobDirectoryQuery = z.infer<typeof jobDirectoryQuerySchema>;

export const jobRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  normalizedTitle: z.string().nullable(),
  companyId: z.string(),
  companyName: z.string(),
  city: z.string().nullable(),
  location: z.string().nullable(),
  roleCategory: z.string().nullable(),
  seniority: senioritySchema,
  workplaceType: workplaceTypeSchema,
  skills: z.array(z.object({ name: z.string(), kind: z.enum(['REQUIRED', 'PREFERRED']) })),
  minYears: z.number().nullable(),
  maxYears: z.number().nullable(),
  /** Of the selected project, or the best across the workspace's projects. */
  matchScore: z.number().nullable(),
  matchConfidence: z.number().nullable(),
  matchProjectId: z.string().nullable(),
  status: jobStatusSchema,
  applicationUrl: z.string().nullable(),
  sourceUrl: z.string(),
  publishedAt: z.string().nullable(),
  analysisState: z.enum(['ANALYZED', 'PENDING']),
});
export type JobRow = z.infer<typeof jobRowSchema>;

export const jobDirectoryResponseSchema = pageMeta.extend({ items: z.array(jobRowSchema) });
export type JobDirectoryResponse = z.infer<typeof jobDirectoryResponseSchema>;
