import { z } from 'zod';

// ---------------------------------------------------------------- enums
export const RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const ACTIVE_RUN_STATUSES: RunStatus[] = ['QUEUED', 'RUNNING'];

export const TASK_STATUSES = [
  'QUEUED',
  'RUNNING',
  'RETRYING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** MISSING = nothing known; UNVERIFIED = reported by a source but unchecked. */
export const FIELD_STATUSES = ['MISSING', 'UNVERIFIED', 'VERIFIED', 'FAILED'] as const;
export const fieldStatusSchema = z.enum(FIELD_STATUSES);
export type FieldStatus = z.infer<typeof fieldStatusSchema>;

export const discoveryOutcomeSchema = z.enum(['CREATED', 'MATCHED', 'REVIEW_REQUIRED']);
export type DiscoveryOutcome = z.infer<typeof discoveryOutcomeSchema>;

export const reviewStatusSchema = z.enum(['PENDING', 'MERGED', 'DISMISSED']);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

// ---------------------------------------------------------------- projects
const listItem = z.string().trim().min(1, 'Empty entries are not allowed').max(100);

/** Trim, drop case-insensitive duplicates, keep first spelling and order. */
function uniqueList(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const list = (max: number) => z.array(listItem).max(max).transform(uniqueList);

const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Country must be an ISO 3166-1 alpha-2 code, e.g. PK');

export const DEFAULT_COUNTRY = 'PK';

const projectFields = {
  name: z.string().trim().min(1, 'Name is required').max(120),
  city: z.string().trim().min(1, 'City is required').max(100),
  industry: z.string().trim().min(1, 'Industry is required').max(100),
  keywords: list(20).refine((k) => k.length >= 1, 'At least one keyword is required'),
};

export const createProjectRequestSchema = z.strictObject({
  ...projectFields,
  country: countrySchema.default(DEFAULT_COUNTRY),
  targetRoles: list(20).default([]),
  targetSkills: list(50).default([]),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/** PATCH: every field optional, and — unlike create — no defaults, so omitted means unchanged. */
export const updateProjectRequestSchema = z
  .strictObject({
    ...projectFields,
    country: countrySchema,
    targetRoles: list(20),
    targetSkills: list(50),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

// ---------------------------------------------------------------- runs
export const runStatsSchema = z.object({
  candidatesFound: z.number(),
  candidatesFiltered: z.number(),
  companiesCreated: z.number(),
  companiesMatched: z.number(),
  reviewsCreated: z.number(),
  duplicatesSkipped: z.number(),
  rejected: z.number(),
});
export type RunStats = z.infer<typeof runStatsSchema>;

export const taskCountsSchema = z.object({
  total: z.number(),
  queued: z.number(),
  running: z.number(),
  retrying: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  cancelled: z.number(),
});
export type TaskCounts = z.infer<typeof taskCountsSchema>;

export const runSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: runStatusSchema,
  cancelRequested: z.boolean(),
  providers: z.array(z.string()),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  stats: runStatsSchema,
  tasks: taskCountsSchema,
});
export type Run = z.infer<typeof runSchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  country: z.string(),
  city: z.string(),
  industry: z.string(),
  keywords: z.array(z.string()),
  targetRoles: z.array(z.string()),
  targetSkills: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRun: runSchema.nullable(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectListResponseSchema = z.object({ items: z.array(projectSchema) });
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

export const runListResponseSchema = z.object({ items: z.array(runSchema) });
export type RunListResponse = z.infer<typeof runListResponseSchema>;

export const providerErrorSummarySchema = z.object({
  taskId: z.string(),
  keyword: z.string().nullable(),
  code: z.string(),
  message: z.string(),
  attempts: z.number(),
  retryable: z.boolean(),
  at: z.string(),
});

export const providerProgressSchema = z.object({
  providerId: z.string(),
  displayName: z.string(),
  attribution: z.string().nullable(),
  tasks: taskCountsSchema,
  candidatesFound: z.number(),
  errors: z.array(providerErrorSummarySchema),
});
export type ProviderProgress = z.infer<typeof providerProgressSchema>;

export const runProgressSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  cancelRequested: z.boolean(),
  /** Terminal tasks / total tasks, 0–100. 0 until the run has been planned. */
  percent: z.number(),
  planned: z.boolean(),
  /** Why the run could not be executed at all (e.g. no provider enabled). */
  error: z.string().nullable(),
  /** Providers that were configured but not used, and why (e.g. missing licence confirmation). */
  skippedProviders: z.array(z.object({ id: z.string(), reason: z.string() })),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  stats: runStatsSchema,
  tasks: taskCountsSchema,
  providers: z.array(providerProgressSchema),
});
export type RunProgress = z.infer<typeof runProgressSchema>;

// ---------------------------------------------------------------- companies
export const companySummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  country: z.string(),
  city: z.string().nullable(),
  website: z.string().nullable(),
  description: z.string().nullable(),
  websiteStatus: fieldStatusSchema,
  emailStatus: fieldStatusSchema,
  careersStatus: fieldStatusSchema,
  status: z.enum(['ACTIVE', 'MERGED']),
  sourceCount: z.number(),
  createdAt: z.string(),
});
export type CompanySummary = z.infer<typeof companySummarySchema>;

export const companyDetailSchema = companySummarySchema.extend({
  mergedIntoId: z.string().nullable(),
  aliases: z.array(z.string()),
  locations: z.array(
    z.object({
      city: z.string().nullable(),
      address: z.string().nullable(),
      lat: z.number().nullable(),
      lng: z.number().nullable(),
      phones: z.array(z.string()),
    }),
  ),
  identities: z.array(z.object({ type: z.string(), scope: z.string(), value: z.string() })),
  sources: z.array(
    z.object({
      providerId: z.string(),
      sourceUrl: z.string().nullable(),
      attribution: z.string().nullable(),
      matchedKeyword: z.string().nullable(),
      retrievedAt: z.string(),
      lastSeenAt: z.string(),
    }),
  ),
});
export type CompanyDetail = z.infer<typeof companyDetailSchema>;

export const companyListResponseSchema = z.object({
  items: z.array(companySummarySchema),
  nextCursor: z.string().nullable(),
});
export type CompanyListResponse = z.infer<typeof companyListResponseSchema>;

export const discoveryResultSchema = z.object({
  id: z.string(),
  outcome: discoveryOutcomeSchema,
  providerId: z.string(),
  keywords: z.array(z.string()),
  matchScore: z.number().nullable(),
  matchReasons: z.array(z.string()),
  createdAt: z.string(),
  company: companySummarySchema,
});
export type DiscoveryResultItem = z.infer<typeof discoveryResultSchema>;

export const discoveryResultListResponseSchema = z.object({
  items: z.array(discoveryResultSchema),
  nextCursor: z.string().nullable(),
});
export type DiscoveryResultListResponse = z.infer<typeof discoveryResultListResponseSchema>;

// ---------------------------------------------------------------- reviews
export const matchReviewSchema = z.object({
  id: z.string(),
  status: reviewStatusSchema,
  score: z.number(),
  reasons: z.array(z.string()),
  candidate: companySummarySchema,
  existing: companySummarySchema,
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type MatchReview = z.infer<typeof matchReviewSchema>;

export const reviewListResponseSchema = z.object({
  items: z.array(matchReviewSchema),
  nextCursor: z.string().nullable(),
});
export type ReviewListResponse = z.infer<typeof reviewListResponseSchema>;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const companyListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
});
export const reviewListQuerySchema = paginationQuerySchema.extend({
  status: reviewStatusSchema.default('PENDING'),
});
