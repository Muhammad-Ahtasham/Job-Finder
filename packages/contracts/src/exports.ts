import { z } from 'zod';
import { fieldStatusSchema } from './discovery';
import { senioritySchema } from './intelligence';
import { employmentTypeSchema, jobStatusSchema, workplaceTypeSchema } from './jobs';

export const exportTypeSchema = z.enum(['COMPANIES', 'JOBS']);
export type ExportType = z.infer<typeof exportTypeSchema>;
export const exportFormatSchema = z.enum(['CSV', 'XLSX']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;
export const exportStatusSchema = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED']);
export type ExportStatus = z.infer<typeof exportStatusSchema>;
export const ACTIVE_EXPORT_STATUSES: ExportStatus[] = ['QUEUED', 'RUNNING'];

const text = (max: number) => z.string().trim().min(1).max(max);

/** The company filters (the same ones the company table offers). Omitted = not filtered. */
export const companyExportFiltersSchema = z
  .strictObject({
    q: text(100),
    city: text(100),
    industry: text(100),
    websiteStatus: fieldStatusSchema,
    hasWebsite: z.boolean(),
    hasHrEmail: z.boolean(),
    hasCareersPage: z.boolean(),
    hiring: z.boolean(),
  })
  .partial();
export type CompanyExportFilters = z.infer<typeof companyExportFiltersSchema>;

export const jobExportFiltersSchema = z
  .strictObject({
    q: text(100),
    city: text(100),
    industry: text(100),
    role: text(100),
    status: jobStatusSchema,
    skill: text(60),
    seniority: senioritySchema,
    employmentType: employmentTypeSchema,
    workplaceType: workplaceTypeSchema,
    companyId: z.string().uuid(),
    /** Only with a project: jobs scoring at least this against it. */
    minMatchScore: z.number().min(0).max(100),
  })
  .partial();
export type JobExportFilters = z.infer<typeof jobExportFiltersSchema>;

const common = {
  format: exportFormatSchema,
  /** Companies the project discovered / the project's job matches. */
  projectId: z.string().uuid().optional(),
};

/**
 * 1. all companies          { type: COMPANIES }
 * 2. filtered companies     { type: COMPANIES, filters }
 * 3. project companies      { type: COMPANIES, projectId }
 * 4. all jobs               { type: JOBS }
 * 5. filtered jobs          { type: JOBS, filters }
 * 6. project job matches    { type: JOBS, projectId }   (best match first, with the project's score)
 */
export const createExportRequestSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('COMPANIES'),
      ...common,
      filters: companyExportFiltersSchema.default({}),
    }),
    z.strictObject({
      type: z.literal('JOBS'),
      ...common,
      filters: jobExportFiltersSchema.default({}),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.type === 'JOBS' && value.filters.minMatchScore !== undefined && !value.projectId) {
      ctx.addIssue({
        code: 'custom',
        path: ['filters', 'minMatchScore'],
        message: 'minMatchScore needs a projectId',
      });
    }
  });
export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;

export const exportSchema = z.object({
  id: z.string(),
  type: exportTypeSchema,
  format: exportFormatSchema,
  /** ALL, FILTERED or PROJECT. */
  scope: z.enum(['ALL', 'FILTERED', 'PROJECT']),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  filters: z.record(z.string(), z.unknown()),
  status: exportStatusSchema,
  progress: z.object({
    rowsProcessed: z.number(),
    rowsTotal: z.number().nullable(),
    /** 0-100; 0 until the total is known. */
    percent: z.number(),
  }),
  rowCount: z.number().nullable(),
  fileName: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  checksum: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** After this the file is deleted; the record stays as history. */
  expiresAt: z.string().nullable(),
  downloadable: z.boolean(),
});
export type Export = z.infer<typeof exportSchema>;

export const exportListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
  status: exportStatusSchema.optional(),
  type: exportTypeSchema.optional(),
});
export type ExportListQuery = z.infer<typeof exportListQuerySchema>;

export const exportListResponseSchema = z.object({
  items: z.array(exportSchema),
  nextCursor: z.string().nullable(),
});
export type ExportListResponse = z.infer<typeof exportListResponseSchema>;

export const exportDownloadQuerySchema = z.object({
  /** `json` returns the short-lived link instead of redirecting to it. */
  mode: z.enum(['redirect', 'json']).default('redirect'),
});

export const exportDownloadLinkSchema = z.object({
  /** A same-origin URL that works without a session for a short time. */
  url: z.string(),
  expiresAt: z.string(),
});
export type ExportDownloadLink = z.infer<typeof exportDownloadLinkSchema>;
