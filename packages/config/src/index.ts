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
  })
  .superRefine((env, ctx) => {
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
  })
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
