import { z } from 'zod';

export const monitoringKindSchema = z.enum(['ATS_BOARD', 'CAREER_PAGE', 'WEBSITE']);
export type MonitoringKind = z.infer<typeof monitoringKindSchema>;
export const scheduleHealthSchema = z.enum(['HEALTHY', 'DEGRADED', 'FAILING', 'PAUSED', 'PENDING']);

/** Bounds of a schedule interval: 1 hour to 30 days. */
export const MIN_INTERVAL_MINUTES = 60;
export const MAX_INTERVAL_MINUTES = 30 * 24 * 60;

const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const monitoringScheduleSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  kind: monitoringKindSchema,
  /** The ATS board / career page being watched; null for the website check. */
  source: z.object({ id: z.string(), providerId: z.string(), url: z.string() }).nullable(),
  enabled: z.boolean(),
  intervalMinutes: z.number(),
  nextRunAt: z.string(),
  lastRunAt: z.string().nullable(),
  /** The last time the source answered. A failed check never moves this. */
  lastSuccessAt: z.string().nullable(),
  lastOutcome: z.string().nullable(),
  /** Provider errors, kept apart from job state: they never open or close a job. */
  consecutiveFailures: z.number(),
  lastError: z
    .object({
      code: z.string().nullable(),
      message: z.string().nullable(),
      at: z.string().nullable(),
    })
    .nullable(),
  health: scheduleHealthSchema,
});
export type MonitoringSchedule = z.infer<typeof monitoringScheduleSchema>;

export const monitoringListQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  kind: monitoringKindSchema.optional(),
  enabled: flag,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});
export type MonitoringListQuery = z.infer<typeof monitoringListQuerySchema>;

export const monitoringListResponseSchema = z.object({
  items: z.array(monitoringScheduleSchema),
  nextCursor: z.string().nullable(),
});
export type MonitoringListResponse = z.infer<typeof monitoringListResponseSchema>;

export const updateScheduleRequestSchema = z
  .strictObject({
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide enabled and/or intervalMinutes');
export type UpdateScheduleRequest = z.infer<typeof updateScheduleRequestSchema>;

export const websiteCheckSchema = z.object({
  id: z.string(),
  outcome: z.enum(['OK', 'FAILED']),
  url: z.string(),
  httpStatus: z.number().nullable(),
  finalDomain: z.string().nullable(),
  changeKind: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string(),
});

export const companyMonitoringSchema = z.object({
  companyId: z.string(),
  /** True when at least one of its schedules is enabled. */
  enabled: z.boolean(),
  schedules: z.array(monitoringScheduleSchema),
  recentWebsiteChecks: z.array(websiteCheckSchema),
});
export type CompanyMonitoring = z.infer<typeof companyMonitoringSchema>;

export const setCompanyMonitoringRequestSchema = z.strictObject({ enabled: z.boolean() });
export type SetCompanyMonitoringRequest = z.infer<typeof setCompanyMonitoringRequestSchema>;

// ---------------------------------------------------------------- notifications
export const notificationTypeSchema = z.enum([
  'NEW_JOB',
  'JOB_CLOSED',
  'JOB_CHANGED',
  'WEBSITE_CHANGED',
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  type: notificationTypeSchema,
  title: z.string(),
  body: z.string(),
  /** Ids for building links; plain data. */
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z.object({
  unread: flag,
  type: notificationTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationListResponseSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number(),
});
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export const markAllReadResponseSchema = z.object({ updated: z.number() });

export const notificationPreferenceSchema = z.object({
  type: notificationTypeSchema,
  inApp: z.boolean(),
  /** Stored now; email is delivered once a mail channel is configured. */
  email: z.boolean(),
});
export const notificationPreferencesResponseSchema = z.object({
  items: z.array(notificationPreferenceSchema),
});
export type NotificationPreferencesResponse = z.infer<typeof notificationPreferencesResponseSchema>;

export const updateNotificationPreferencesRequestSchema = z.strictObject({
  preferences: z
    .array(
      z.strictObject({
        type: notificationTypeSchema,
        inApp: z.boolean().optional(),
        email: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(10),
});
export type UpdateNotificationPreferencesRequest = z.infer<
  typeof updateNotificationPreferencesRequestSchema
>;
