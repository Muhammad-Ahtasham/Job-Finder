import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Strict boolean parser. `z.coerce.boolean()` treats the string "false" as true,
 * which is a classic configuration footgun, so we parse explicitly.
 */
const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/** `.env` files commonly contain `KEY=` for unset values; treat blank as "not set". */
const optionalString = <T extends z.ZodType<string>>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const positiveInt = (name: string) =>
  z.coerce
    .number({ message: `${name} must be a number` })
    .int()
    .positive();

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/** Variables every backend process needs. */
export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel.optional(),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a postgres:// URL'),
  REDIS_URL: z
    .string()
    .min(1)
    .refine((v) => /^rediss?:\/\//.test(v), 'REDIS_URL must be a redis:// or rediss:// URL'),
});

/** Where export files are kept: a directory (development) or an S3-compatible bucket. */
const exportStorageFields = {
  EXPORT_STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  /** fs driver. Default: <repo>/.data/exports */
  EXPORT_STORAGE_DIR: optionalString(z.string().trim().min(1)),
  EXPORT_S3_ENDPOINT: optionalString(z.url()),
  EXPORT_S3_REGION: z.string().trim().min(1).default('us-east-1'),
  EXPORT_S3_BUCKET: optionalString(z.string().trim().min(3)),
  EXPORT_S3_ACCESS_KEY_ID: optionalString(z.string().trim().min(1)),
  EXPORT_S3_SECRET_ACCESS_KEY: optionalString(z.string().trim().min(1)),
  EXPORT_S3_FORCE_PATH_STYLE: booleanFromString.default(true),
};

function requireS3Settings(
  env: {
    EXPORT_STORAGE_DRIVER: 'fs' | 's3';
    EXPORT_S3_BUCKET?: string;
    EXPORT_S3_ACCESS_KEY_ID?: string;
    EXPORT_S3_SECRET_ACCESS_KEY?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (env.EXPORT_STORAGE_DRIVER !== 's3') return;
  for (const key of [
    'EXPORT_S3_BUCKET',
    'EXPORT_S3_ACCESS_KEY_ID',
    'EXPORT_S3_SECRET_ACCESS_KEY',
  ] as const) {
    if (!env[key]) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is required when EXPORT_STORAGE_DRIVER=s3`,
      });
    }
  }
}

export type ExportStorageConfig =
  | { driver: 'fs'; directory: string }
  | {
      driver: 's3';
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

/** The validated storage settings as a plain config object. */
export function exportStorageConfig(env: {
  EXPORT_STORAGE_DRIVER: 'fs' | 's3';
  EXPORT_STORAGE_DIR?: string;
  EXPORT_S3_ENDPOINT?: string;
  EXPORT_S3_REGION: string;
  EXPORT_S3_BUCKET?: string;
  EXPORT_S3_ACCESS_KEY_ID?: string;
  EXPORT_S3_SECRET_ACCESS_KEY?: string;
  EXPORT_S3_FORCE_PATH_STYLE: boolean;
}): ExportStorageConfig {
  if (env.EXPORT_STORAGE_DRIVER === 's3') {
    return {
      driver: 's3',
      endpoint: env.EXPORT_S3_ENDPOINT,
      region: env.EXPORT_S3_REGION,
      bucket: env.EXPORT_S3_BUCKET!,
      accessKeyId: env.EXPORT_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.EXPORT_S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.EXPORT_S3_FORCE_PATH_STYLE,
    };
  }
  return {
    driver: 'fs',
    directory:
      env.EXPORT_STORAGE_DIR ?? join(findWorkspaceRoot() ?? process.cwd(), '.data', 'exports'),
  };
}

/** Used only when nothing is configured outside production; production must set its own. */
const DEV_EXPORT_LINK_SECRET = 'dev-only-export-link-secret-do-not-use-in-production';

/** How often each kind of thing is checked (hours). Configurable here and per schedule via the API. */
const monitorIntervalFields = {
  /** ATS boards (Greenhouse, Lever, Ashby): 12-24 h. */
  MONITOR_ATS_INTERVAL_HOURS: positiveInt('MONITOR_ATS_INTERVAL_HOURS').max(720).default(12),
  MONITOR_CAREER_PAGE_INTERVAL_HOURS: positiveInt('MONITOR_CAREER_PAGE_INTERVAL_HOURS')
    .max(720)
    .default(24),
  MONITOR_WEBSITE_INTERVAL_HOURS: positiveInt('MONITOR_WEBSITE_INTERVAL_HOURS')
    .max(720)
    .default(168),
};

export function monitoringIntervals(env: {
  MONITOR_ATS_INTERVAL_HOURS: number;
  MONITOR_CAREER_PAGE_INTERVAL_HOURS: number;
  MONITOR_WEBSITE_INTERVAL_HOURS: number;
}) {
  return {
    atsMinutes: env.MONITOR_ATS_INTERVAL_HOURS * 60,
    careerPageMinutes: env.MONITOR_CAREER_PAGE_INTERVAL_HOURS * 60,
    websiteMinutes: env.MONITOR_WEBSITE_INTERVAL_HOURS * 60,
  };
}

export const apiEnvSchema = baseEnvSchema
  .extend({
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: positiveInt('API_PORT').default(4000),
    WEB_ORIGIN: z
      .string()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(
            z.string().refine((origin) => {
              try {
                const url = new URL(origin);
                return url.origin === origin; // no trailing slash / path
              } catch {
                return false;
              }
            }, 'WEB_ORIGIN entries must be bare origins like http://localhost:3000'),
          )
          .min(1),
      ),
    SESSION_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, 'invalid cookie name')
      .default('jf_session'),
    SESSION_COOKIE_SECURE: booleanFromString.optional(),
    SESSION_ABSOLUTE_TTL_HOURS: positiveInt('SESSION_ABSOLUTE_TTL_HOURS').default(168),
    SESSION_IDLE_TTL_HOURS: positiveInt('SESSION_IDLE_TTL_HOURS').default(24),
    SESSION_ROTATE_AFTER_MINUTES: positiveInt('SESSION_ROTATE_AFTER_MINUTES').default(60),
    AUTH_RATE_LIMIT_PER_MINUTE: positiveInt('AUTH_RATE_LIMIT_PER_MINUTE').default(10),
    /** Swagger UI at /docs. Defaults to on outside production. */
    SWAGGER_ENABLED: booleanFromString.optional(),

    // ---- Exports (see docs/adr/0007-exports.md) ----
    ...exportStorageFields,
    /** HMAC key for short-lived download links. Required in production (>= 32 characters). */
    EXPORT_LINK_SECRET: optionalString(
      z.string().min(32, 'EXPORT_LINK_SECRET must be at least 32 characters'),
    ),
    EXPORT_LINK_TTL_SECONDS: positiveInt('EXPORT_LINK_TTL_SECONDS').max(900).default(60),
    ...monitorIntervalFields,
    /** Queued + running exports one workspace may have at a time. */
    EXPORT_MAX_ACTIVE_PER_WORKSPACE: positiveInt('EXPORT_MAX_ACTIVE_PER_WORKSPACE')
      .max(20)
      .default(3),
  })
  .superRefine((env, ctx) => {
    requireS3Settings(env, ctx);
    if (env.NODE_ENV === 'production' && !env.EXPORT_LINK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['EXPORT_LINK_SECRET'],
        message: 'EXPORT_LINK_SECRET is required in production',
      });
    }
    const secure = env.SESSION_COOKIE_SECURE ?? env.NODE_ENV === 'production';
    if (env.NODE_ENV === 'production' && !secure) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'SESSION_COOKIE_SECURE must be true in production',
      });
    }
    if (env.SESSION_IDLE_TTL_HOURS > env.SESSION_ABSOLUTE_TTL_HOURS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_IDLE_TTL_HOURS'],
        message: 'SESSION_IDLE_TTL_HOURS cannot exceed SESSION_ABSOLUTE_TTL_HOURS',
      });
    }
  })
  .transform((env) => ({
    ...env,
    LOG_LEVEL: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
    EXPORT_LINK_SECRET: env.EXPORT_LINK_SECRET ?? DEV_EXPORT_LINK_SECRET,
    SESSION_COOKIE_SECURE: env.SESSION_COOKIE_SECURE ?? env.NODE_ENV === 'production',
    SWAGGER_ENABLED: env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production',
  }));

export const workerEnvSchema = baseEnvSchema
  .extend({
    WORKER_HEARTBEAT_INTERVAL_MS: positiveInt('WORKER_HEARTBEAT_INTERVAL_MS').default(10_000),
    /** Same variable the API uses: the worker purges sessions idle for longer than this. */
    SESSION_IDLE_TTL_HOURS: positiveInt('SESSION_IDLE_TTL_HOURS').default(24),

    // ---- Company discovery providers (see docs/provider-terms-register.md) ----
    /** Comma-separated provider ids to enable. Unknown ids are reported and skipped at boot. */
    DISCOVERY_PROVIDERS: z
      .string()
      .default('overpass-osm')
      .transform((value) =>
        value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    /** Email or URL where the operator can be reached; sent in the User-Agent (OSM policy). */
    DISCOVERY_CONTACT: optionalString(z.string().trim().max(200)),
    BRAVE_SEARCH_API_KEY: optionalString(z.string().trim().min(1)),
    /** Must be "true" to enable Brave: its terms bar storing results without a storage-rights plan. */
    BRAVE_SEARCH_STORAGE_RIGHTS: booleanFromString.default(false),
    BRAVE_SEARCH_RPS: positiveInt('BRAVE_SEARCH_RPS').default(1),
    BRAVE_SEARCH_PAGES: positiveInt('BRAVE_SEARCH_PAGES').max(10).default(2),
    /** Prefer your own Overpass instance (Geofabrik extract) over the public one for real use. */
    OVERPASS_API_URL: z.url().default('https://overpass-api.de/api/interpreter'),
    OVERPASS_MIN_INTERVAL_MS: positiveInt('OVERPASS_MIN_INTERVAL_MS').default(5000),
    /** Tasks stuck in QUEUED/RETRYING longer than this are re-enqueued by the reconciler. */
    DISCOVERY_RECONCILE_STALE_SECONDS: positiveInt('DISCOVERY_RECONCILE_STALE_SECONDS').default(60),
    /** Exponential backoff base for retrying failed provider calls. */
    DISCOVERY_RETRY_BASE_MS: positiveInt('DISCOVERY_RETRY_BASE_MS').default(5000),
    DISCOVERY_MAX_ATTEMPTS: positiveInt('DISCOVERY_MAX_ATTEMPTS').max(10).default(5),

    // ---- Company website enrichment (see docs/adr/0004-website-enrichment.md) ----
    ENRICHMENT_CONCURRENCY: positiveInt('ENRICHMENT_CONCURRENCY').max(20).default(2),
    /** Minimum spacing between requests to one registrable domain, across all workers. */
    ENRICHMENT_DOMAIN_MIN_INTERVAL_MS: positiveInt('ENRICHMENT_DOMAIN_MIN_INTERVAL_MS').default(
      2000,
    ),
    ENRICHMENT_REQUEST_TIMEOUT_MS: positiveInt('ENRICHMENT_REQUEST_TIMEOUT_MS').default(10_000),
    ENRICHMENT_MAX_RESPONSE_BYTES: positiveInt('ENRICHMENT_MAX_RESPONSE_BYTES').default(1_048_576),
    ENRICHMENT_MAX_REQUESTS_PER_SITE: positiveInt('ENRICHMENT_MAX_REQUESTS_PER_SITE')
      .max(50)
      .default(12),
    ENRICHMENT_MAX_ATTEMPTS: positiveInt('ENRICHMENT_MAX_ATTEMPTS').max(10).default(3),
    ENRICHMENT_RETRY_BASE_MS: positiveInt('ENRICHMENT_RETRY_BASE_MS').default(10_000),
    /** Runs stuck in QUEUED/RUNNING longer than this are re-enqueued by the reconciler. */
    ENRICHMENT_RECONCILE_STALE_SECONDS: positiveInt('ENRICHMENT_RECONCILE_STALE_SECONDS').default(
      120,
    ),
    /** Optional. Enables AI second opinions for ambiguous pages/contacts only. */
    ANTHROPIC_API_KEY: optionalString(z.string().trim().min(1)),
    ENRICHMENT_AI_MODEL: z.string().trim().min(1).default('claude-haiku-5-5'),

    // ---- Career pages and job providers (see docs/adr/0005-job-discovery.md) ----
    JOBS_CONCURRENCY: positiveInt('JOBS_CONCURRENCY').max(20).default(2),
    /** Minimum spacing between requests to one ATS API host, across all workers. */
    JOBS_API_MIN_INTERVAL_MS: positiveInt('JOBS_API_MIN_INTERVAL_MS').default(1000),
    JOBS_MAX_CAREER_FETCHES: positiveInt('JOBS_MAX_CAREER_FETCHES').max(20).default(6),
    JOBS_MAX_ATTEMPTS: positiveInt('JOBS_MAX_ATTEMPTS').max(10).default(3),
    JOBS_RETRY_BASE_MS: positiveInt('JOBS_RETRY_BASE_MS').default(10_000),
    JOBS_RECONCILE_STALE_SECONDS: positiveInt('JOBS_RECONCILE_STALE_SECONDS').default(120),
    /** An OPEN job nobody has confirmed for this long becomes UNKNOWN (never CLOSED: absence of proof). */
    JOBS_STALE_AFTER_DAYS: positiveInt('JOBS_STALE_AFTER_DAYS').max(365).default(14),

    // ---- Job intelligence and matching (see docs/adr/0006-job-intelligence.md) ----
    /** Set to false to run analysis and matching on rules only, even with an API key. */
    INTELLIGENCE_AI_ENABLED: booleanFromString.default(true),
    /** Model for job analysis and semantic matching (uses ANTHROPIC_API_KEY). */
    INTELLIGENCE_AI_MODEL: z.string().trim().min(1).default('claude-haiku-5-5'),
    /** Jobs analysed per sweep (every 30 s). */
    INTELLIGENCE_BATCH_SIZE: positiveInt('INTELLIGENCE_BATCH_SIZE').max(200).default(25),
    INTELLIGENCE_CONCURRENCY: positiveInt('INTELLIGENCE_CONCURRENCY').max(10).default(2),
    INTELLIGENCE_MAX_ATTEMPTS: positiveInt('INTELLIGENCE_MAX_ATTEMPTS').max(10).default(3),

    // ---- Exports (see docs/adr/0007-exports.md) ----
    ...exportStorageFields,
    EXPORT_CONCURRENCY: positiveInt('EXPORT_CONCURRENCY').max(10).default(2),
    EXPORT_MAX_ATTEMPTS: positiveInt('EXPORT_MAX_ATTEMPTS').max(10).default(3),
    EXPORT_RETRY_BASE_MS: positiveInt('EXPORT_RETRY_BASE_MS').default(5000),
    /** Rows read from the database per batch. */
    EXPORT_BATCH_SIZE: positiveInt('EXPORT_BATCH_SIZE').max(5000).default(500),
    /** Larger exports fail with a clear message instead of exhausting memory/disk. */
    EXPORT_MAX_ROWS: positiveInt('EXPORT_MAX_ROWS').max(1_000_000).default(100_000),
    /** Files are deleted this long after they are created; the history entry stays. */
    EXPORT_RETENTION_DAYS: positiveInt('EXPORT_RETENTION_DAYS').max(365).default(7),
    /** Exports stuck in QUEUED/RUNNING longer than this are re-enqueued. */
    EXPORT_RECONCILE_STALE_SECONDS: positiveInt('EXPORT_RECONCILE_STALE_SECONDS').default(120),

    // ---- Scheduled monitoring (see docs/adr/0008-monitoring.md) ----
    ...monitorIntervalFields,
    /** Master switch: false stops every scheduled check (schedules and notifications are kept). */
    MONITOR_ENABLED: booleanFromString.default(true),
    /** Due schedules claimed per scheduler tick (the tick runs every minute). */
    MONITOR_BATCH_SIZE: positiveInt('MONITOR_BATCH_SIZE').max(500).default(25),
    MONITOR_CONCURRENCY: positiveInt('MONITOR_CONCURRENCY').max(20).default(2),
    MONITOR_MAX_ATTEMPTS: positiveInt('MONITOR_MAX_ATTEMPTS').max(10).default(2),
    /** After a failed check retry after this long, doubling per failure up to the normal interval. */
    MONITOR_FAILURE_BACKOFF_MINUTES: positiveInt('MONITOR_FAILURE_BACKOFF_MINUTES').default(30),
    /** A job missed by an authoritative check is looked for again after this long. */
    MONITOR_RECHECK_MINUTES: positiveInt('MONITOR_RECHECK_MINUTES').default(30),
    /** Separate checks that must all miss a job before it is closed (the source saying so closes at once). */
    MONITOR_MISS_CONFIRMATIONS: positiveInt('MONITOR_MISS_CONFIRMATIONS').max(10).default(2),
    /** The confirming check must come at least this long after the first miss. */
    MONITOR_MISS_MIN_GAP_MINUTES: z.coerce.number().int().min(0).max(1440).default(10),
    /** A schedule claimed by a tick is not claimed again for this long. */
    MONITOR_LOCK_MINUTES: positiveInt('MONITOR_LOCK_MINUTES').default(15),
    /** Consecutive failed website checks before "website unavailable" is announced. */
    MONITOR_WEBSITE_FAILURES_BEFORE_ALERT: positiveInt(
      'MONITOR_WEBSITE_FAILURES_BEFORE_ALERT',
    ).default(3),
  })
  .superRefine(requireS3Settings)
  .transform((env) => ({
    ...env,
    LOG_LEVEL: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
  }));

export const webEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  API_INTERNAL_URL: z.url({ message: 'API_INTERNAL_URL must be a valid URL' }),
});

export type ApiEnv = z.output<typeof apiEnvSchema>;
export type WorkerEnv = z.output<typeof workerEnvSchema>;
export type WebEnv = z.output<typeof webEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validate an env source against a schema. Throws EnvValidationError listing every
 * problem (variable names only — values are never echoed, they may be secrets).
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Walk up from `start` to the directory containing pnpm-workspace.yaml. */
export function findWorkspaceRoot(start: string = process.cwd()): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Load the repo-root `.env` into process.env (never overriding variables that are
 * already set, so real environment / CI values win). Safe to call repeatedly.
 */
export function loadRootDotenv(): void {
  const root = findWorkspaceRoot();
  if (!root) return;
  const file = join(root, '.env');
  if (existsSync(file)) loadDotenv({ path: file, override: false, quiet: true });
}

export const loadApiEnv = (): ApiEnv => {
  loadRootDotenv();
  return parseEnv(apiEnvSchema);
};

export const loadWorkerEnv = (): WorkerEnv => {
  loadRootDotenv();
  return parseEnv(workerEnvSchema);
};

export const loadWebEnv = (): WebEnv => parseEnv(webEnvSchema);
