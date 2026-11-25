import { z } from 'zod';
import { companyPageSchema, extractionErrorSchema, extractionStatusSchema } from './enrichment';

export const employmentTypeSchema = z.enum([
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERNSHIP',
  'TEMPORARY',
  'OTHER',
  'UNKNOWN',
]);
export type EmploymentType = z.infer<typeof employmentTypeSchema>;

export const workplaceTypeSchema = z.enum(['ONSITE', 'REMOTE', 'HYBRID', 'UNKNOWN']);
export type WorkplaceType = z.infer<typeof workplaceTypeSchema>;

export const jobStatusSchema = z.enum(['OPEN', 'CLOSED']);
export const jobSourceStatusSchema = z.enum(['ACTIVE', 'UNSUPPORTED', 'DISABLED']);

/**
 * JOBS = jobs found · NO_OPENINGS = the source reported zero ·
 * INCONCLUSIVE / FAILED = we do NOT know (never "zero vacancies").
 */
export const jobCheckOutcomeSchema = z.enum(['JOBS', 'NO_OPENINGS', 'INCONCLUSIVE', 'FAILED']);
export type JobCheckOutcome = z.infer<typeof jobCheckOutcomeSchema>;

export const jobSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  providerId: z.string(),
  externalId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  locations: z.array(z.string()),
  department: z.string().nullable(),
  employmentType: employmentTypeSchema,
  workplaceType: workplaceTypeSchema,
  /** Exactly as the provider published it; this system never applies on anyone's behalf. */
  applicationUrl: z.string().nullable(),
  sourceUrl: z.string(),
  publishedAt: z.string().nullable(),
  extraction: z.string(),
  status: jobStatusSchema,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export const jobListResponseSchema = z.object({
  companyId: z.string(),
  items: z.array(jobSchema),
  nextCursor: z.string().nullable(),
});
export type JobListResponse = z.infer<typeof jobListResponseSchema>;

export const jobListQuerySchema = z.object({
  status: jobStatusSchema.default('OPEN'),
  employmentType: employmentTypeSchema.optional(),
  workplaceType: workplaceTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

export const jobCheckSchema = z.object({
  id: z.string(),
  outcome: jobCheckOutcomeSchema,
  authoritative: z.boolean(),
  jobsFound: z.number(),
  jobsCreated: z.number(),
  jobsUpdated: z.number(),
  jobsClosed: z.number(),
  duplicatesSkipped: z.number(),
  pagesFetched: z.number(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean().nullable(),
  httpStatus: z.number().nullable(),
  evidence: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type JobCheck = z.infer<typeof jobCheckSchema>;

export const jobSourceSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  boardKey: z.string(),
  boardUrl: z.string(),
  status: jobSourceStatusSchema,
  discoveredFromUrl: z.string().nullable(),
  discoveryConfidence: z.number().nullable(),
  discoveryEvidence: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastOutcome: jobCheckOutcomeSchema.nullable(),
  consecutiveFailures: z.number(),
  openJobs: z.number(),
  latestChecks: z.array(jobCheckSchema),
});
export type JobSource = z.infer<typeof jobSourceSchema>;

export const jobRunSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  status: extractionStatusSchema,
  attempts: z.number(),
  careerPagesFound: z.number(),
  sourcesChecked: z.number(),
  jobsFound: z.number(),
  stats: z.record(z.string(), z.number()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  errors: z.array(extractionErrorSchema),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type JobRun = z.infer<typeof jobRunSchema>;

export const jobRefreshResponseSchema = z.object({
  run: jobRunSchema,
  /** True when discovery for this company was already queued/running and is being reused. */
  reused: z.boolean(),
});
export type JobRefreshResponse = z.infer<typeof jobRefreshResponseSchema>;

export const jobSourcesResponseSchema = z.object({
  companyId: z.string(),
  careerPages: z.array(companyPageSchema),
  sources: z.array(jobSourceSchema),
  runs: z.array(jobRunSchema),
  /**
   * Whether the company's vacancy picture is trustworthy right now:
   * KNOWN = at least one source answered; UNKNOWN = sources exist but none has answered
   * successfully (or none were found) — absence of jobs then means "not known", not "none".
   */
  vacancyKnowledge: z.enum(['KNOWN', 'UNKNOWN']),
});
export type JobSourcesResponse = z.infer<typeof jobSourcesResponseSchema>;
