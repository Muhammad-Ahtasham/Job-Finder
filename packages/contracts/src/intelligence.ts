import { z } from 'zod';
import { employmentTypeSchema, jobSchema, jobStatusSchema, workplaceTypeSchema } from './jobs';

export const senioritySchema = z.enum([
  'INTERN',
  'JUNIOR',
  'MID',
  'SENIOR',
  'LEAD',
  'MANAGER',
  'DIRECTOR',
  'EXECUTIVE',
  'UNKNOWN',
]);
export type Seniority = z.infer<typeof senioritySchema>;

export const salaryPeriodSchema = z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR']);

export const jobSkillSchema = z.object({
  key: z.string(),
  name: z.string(),
  kind: z.enum(['REQUIRED', 'PREFERRED']),
  evidence: z.string().nullable(),
  source: z.enum(['RULES', 'AI']),
});
export type JobSkill = z.infer<typeof jobSkillSchema>;

export const jobRequirementSchema = z.object({
  kind: z.enum(['EXPERIENCE', 'EDUCATION', 'CERTIFICATION', 'LANGUAGE', 'OTHER']),
  text: z.string(),
  mandatory: z.boolean(),
  minYears: z.number().nullable(),
  maxYears: z.number().nullable(),
  level: z.string().nullable(),
  source: z.enum(['RULES', 'AI']),
});
export type JobRequirement = z.infer<typeof jobRequirementSchema>;

/** Present only when the posting published a salary; `text` is the wording it was read from. */
export const jobSalarySchema = z.object({
  min: z.number().nullable(),
  max: z.number().nullable(),
  currency: z.string().nullable(),
  period: salaryPeriodSchema.nullable(),
  text: z.string().nullable(),
});

export const jobAnalysisInfoSchema = z.object({
  state: z.enum(['ANALYZED', 'PENDING']),
  analyzedAt: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  confidence: z.number().nullable(),
});

export const jobDetailSchema = jobSchema.extend({
  companyId: z.string(),
  companyName: z.string(),
  normalizedTitle: z.string().nullable(),
  seniority: senioritySchema,
  roleCategory: z.string().nullable(),
  salary: jobSalarySchema.nullable(),
  minYearsExperience: z.number().nullable(),
  maxYearsExperience: z.number().nullable(),
  expiresAt: z.string().nullable(),
  statusReason: z.string().nullable(),
  statusChangedAt: z.string().nullable(),
  skills: z.array(jobSkillSchema),
  requirements: z.array(jobRequirementSchema),
  analysis: jobAnalysisInfoSchema,
});
export type JobDetail = z.infer<typeof jobDetailSchema>;

export const jobSearchQuerySchema = z.object({
  /** Omit for every status. */
  status: jobStatusSchema.optional(),
  companyId: z.string().uuid().optional(),
  seniority: senioritySchema.optional(),
  employmentType: employmentTypeSchema.optional(),
  workplaceType: workplaceTypeSchema.optional(),
  roleCategory: z.string().trim().min(1).max(60).optional(),
  /** A skill name or alias ("node", "Node.js" and "nodejs" are the same skill). */
  skill: z.string().trim().min(1).max(60).optional(),
  /** Case-insensitive match on the title. */
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});
export type JobSearchQuery = z.infer<typeof jobSearchQuerySchema>;

export const jobSearchResponseSchema = z.object({
  items: z.array(jobDetailSchema),
  nextCursor: z.string().nullable(),
});
export type JobSearchResponse = z.infer<typeof jobSearchResponseSchema>;

// ---------------------------------------------------------------- history

export const jobObservationSchema = z.object({
  id: z.string(),
  kind: z.enum(['FIRST_SEEN', 'SEEN', 'CHANGED', 'MISSING', 'STATUS_CHANGED', 'ANALYZED']),
  fromStatus: jobStatusSchema.nullable(),
  toStatus: jobStatusSchema.nullable(),
  reason: z.string().nullable(),
  changes: z.record(z.string(), z.unknown()),
  checkId: z.string().nullable(),
  observedAt: z.string(),
});
export type JobObservation = z.infer<typeof jobObservationSchema>;

export const jobHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});

export const jobHistoryResponseSchema = z.object({
  jobId: z.string(),
  status: jobStatusSchema,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  /** Newest first. */
  items: z.array(jobObservationSchema),
  nextCursor: z.string().nullable(),
});
export type JobHistoryResponse = z.infer<typeof jobHistoryResponseSchema>;

// ---------------------------------------------------------------- matching preferences

export const matchWeightsSchema = z.object({
  role: z.number().min(0).max(1),
  skills: z.number().min(0).max(1),
  experience: z.number().min(0).max(1),
  location: z.number().min(0).max(1),
});
export type MatchWeights = z.infer<typeof matchWeightsSchema>;

const weightsSum = (w: MatchWeights) => w.role + w.skills + w.experience + w.location;

export const matchPreferencesSchema = z.object({
  /** Relative weights; they are rescaled to sum to 1 when scoring. Defaults: 0.3 / 0.4 / 0.2 / 0.1. */
  weights: matchWeightsSchema,
  /** The ideal hire's years of experience. */
  yearsExperience: z.number().int().min(0).max(60).nullable(),
  seniorities: z.array(senioritySchema.exclude(['UNKNOWN'])).max(8),
  workplaceTypes: z.array(workplaceTypeSchema.exclude(['UNKNOWN'])).max(3),
  /** Preferred places; empty means the project's own city and country. */
  locations: z.array(z.string().trim().min(1).max(100)).max(20),
  /** Default floor (0-100) for the matches list. */
  minScore: z.number().int().min(0).max(100),
  version: z.number().int(),
  updatedAt: z.string().nullable(),
});
export type MatchPreferences = z.infer<typeof matchPreferencesSchema>;

export const updateMatchPreferencesRequestSchema = z
  .strictObject({
    weights: matchWeightsSchema.partial(),
    yearsExperience: z.number().int().min(0).max(60).nullable(),
    seniorities: z.array(senioritySchema.exclude(['UNKNOWN'])).max(8),
    workplaceTypes: z.array(workplaceTypeSchema.exclude(['UNKNOWN'])).max(3),
    locations: z.array(z.string().trim().min(1).max(100)).max(20),
    minScore: z.number().int().min(0).max(100),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');
export type UpdateMatchPreferencesRequest = z.infer<typeof updateMatchPreferencesRequestSchema>;

export const validWeights = (w: MatchWeights): boolean => weightsSum(w) > 0;

// ---------------------------------------------------------------- matches

export const matchEvidenceSchema = z.object({
  kind: z.enum(['ROLE', 'SKILL_MATCHED', 'SKILL_MISSING', 'EXPERIENCE', 'LOCATION', 'WORKPLACE']),
  label: z.string(),
  detail: z.string().nullable(),
  jobText: z.string().nullable(),
  score: z.number().nullable(),
});

export const jobMatchSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** 0-100 */
  score: z.number().min(0).max(100),
  /** Component scores 0-1; null = could not be judged (and left out of the score). */
  components: z.object({
    role: z.number().nullable(),
    skills: z.number().nullable(),
    experience: z.number().nullable(),
    location: z.number().nullable(),
  }),
  weights: matchWeightsSchema,
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  experienceFit: z.enum(['MEETS', 'BELOW', 'ABOVE', 'UNKNOWN']),
  locationFit: z.enum(['MATCH', 'PARTIAL', 'MISMATCH', 'UNKNOWN']),
  explanation: z.string(),
  explanationSource: z.enum(['RULES', 'AI']),
  confidence: z.number().min(0).max(1),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  computedAt: z.string(),
  evidence: z.array(matchEvidenceSchema),
  job: jobDetailSchema,
});
export type JobMatch = z.infer<typeof jobMatchSchema>;

export const matchListQuerySchema = z.object({
  /** Defaults to the project's matching preference `minScore`. */
  minScore: z.coerce.number().min(0).max(100).optional(),
  /** Job status; defaults to OPEN. */
  status: jobStatusSchema.default('OPEN'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Opaque: returned as `nextCursor`. */
  cursor: z.string().max(100).optional(),
});
export type MatchListQuery = z.infer<typeof matchListQuerySchema>;

export const matchListResponseSchema = z.object({
  projectId: z.string(),
  items: z.array(jobMatchSchema),
  nextCursor: z.string().nullable(),
  /** Jobs of the project's companies that have no up-to-date match yet (analysis/matching pending). */
  pendingJobs: z.number(),
});
export type MatchListResponse = z.infer<typeof matchListResponseSchema>;

export const matchRefreshResponseSchema = z.object({ queued: z.boolean() });
