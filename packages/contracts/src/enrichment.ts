import { z } from 'zod';
import { fieldStatusSchema } from './discovery';

// ---------------------------------------------------------------- enums
export const EXTRACTION_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
] as const;
export const extractionStatusSchema = z.enum(EXTRACTION_STATUSES);
export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;
export const ACTIVE_EXTRACTION_STATUSES: ExtractionStatus[] = ['QUEUED', 'RUNNING'];

export const pageTypeSchema = z.enum([
  'HOMEPAGE',
  'ABOUT',
  'CONTACT',
  'CAREERS',
  'JOBS',
  'TEAM',
  'OTHER',
]);
export type PageType = z.infer<typeof pageTypeSchema>;

export const pageFetchStatusSchema = z.enum([
  'DISCOVERED',
  'FETCHED',
  'BLOCKED_ROBOTS',
  'BLOCKED_UNSAFE',
  'FAILED',
]);

export const contactKindSchema = z.enum(['EMAIL', 'LINKEDIN']);
export type ContactKind = z.infer<typeof contactKindSchema>;

export const emailCategorySchema = z.enum(['HR', 'CAREERS', 'RECRUITMENT', 'GENERAL', 'OTHER']);
export type EmailCategory = z.infer<typeof emailCategorySchema>;

export const classifiedBySchema = z.enum(['RULES', 'AI']);
export const websiteDecisionSchema = z.enum(['OFFICIAL', 'REJECTED', 'UNCERTAIN']);
export const companyReviewStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED']);

// ---------------------------------------------------------------- runs
export const extractionErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

export const extractionRunSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  status: extractionStatusSchema,
  attempts: z.number(),
  websiteUrl: z.string().nullable(),
  pagesFound: z.number(),
  contactsFound: z.number(),
  stats: z.record(z.string(), z.number()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  errors: z.array(extractionErrorSchema),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type ExtractionRun = z.infer<typeof extractionRunSchema>;

export const enrichResponseSchema = z.object({
  run: extractionRunSchema,
  /** True when an enrichment of this company was already queued/running and is being reused. */
  reused: z.boolean(),
});
export type EnrichResponse = z.infer<typeof enrichResponseSchema>;

// ---------------------------------------------------------------- sources
export const evidenceSchema = z.object({
  signal: z.string(),
  detail: z.string(),
  weight: z.number(),
  url: z.string().optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const companyReviewSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.literal('WEBSITE'),
  subjectUrl: z.string(),
  domain: z.string(),
  decision: websiteDecisionSchema,
  confidence: z.number(),
  evidence: z.array(evidenceSchema),
  status: companyReviewStatusSchema,
  decidedManually: z.boolean(),
  resolvedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type CompanyReview = z.infer<typeof companyReviewSchema>;

export const companyPageSchema = z.object({
  id: z.string(),
  url: z.string(),
  type: pageTypeSchema,
  typeConfidence: z.number(),
  classifiedBy: classifiedBySchema,
  title: z.string().nullable(),
  fetchStatus: pageFetchStatusSchema,
  httpStatus: z.number().nullable(),
  errorCode: z.string().nullable(),
  external: z.boolean(),
  discoveredFrom: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  lastSeenAt: z.string(),
});
export type CompanyPage = z.infer<typeof companyPageSchema>;

export const companySourcesResponseSchema = z.object({
  companyId: z.string(),
  website: z.object({
    url: z.string().nullable(),
    status: fieldStatusSchema,
    /** The decision (and its evidence) that accepted `url`, when enrichment made one. */
    review: companyReviewSchema.nullable(),
  }),
  careersStatus: fieldStatusSchema,
  emailStatus: fieldStatusSchema,
  pages: z.array(companyPageSchema),
  /** Every website candidate that was evaluated, including rejected ones. */
  candidates: z.array(companyReviewSchema),
  runs: z.array(extractionRunSchema),
  lastEnrichedAt: z.string().nullable(),
});
export type CompanySourcesResponse = z.infer<typeof companySourcesResponseSchema>;

// ---------------------------------------------------------------- contacts
export const companyContactSchema = z.object({
  id: z.string(),
  kind: contactKindSchema,
  value: z.string(),
  category: emailCategorySchema.nullable(),
  classifiedBy: classifiedBySchema,
  confidence: z.number(),
  /** VERIFIED = published on the verified official site. It never means the mailbox exists. */
  verificationStatus: fieldStatusSchema,
  verificationMethod: z.string(),
  extractionMethod: z.string(),
  sourceUrl: z.string(),
  context: z.string().nullable(),
  domainMatch: z.boolean().nullable(),
  extractedAt: z.string(),
  lastSeenAt: z.string(),
});
export type CompanyContact = z.infer<typeof companyContactSchema>;

export const companyContactsQuerySchema = z.object({
  kind: contactKindSchema.optional(),
  category: emailCategorySchema.optional(),
});
export const companyContactsResponseSchema = z.object({
  companyId: z.string(),
  items: z.array(companyContactSchema),
});
export type CompanyContactsResponse = z.infer<typeof companyContactsResponseSchema>;

export const companyReviewListResponseSchema = z.object({
  items: z.array(companyReviewSchema),
});
