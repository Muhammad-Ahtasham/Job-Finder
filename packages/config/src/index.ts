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
