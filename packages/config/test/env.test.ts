import { describe, expect, it } from 'vitest';
import {
  apiEnvSchema,
  exportStorageConfig,
  EnvValidationError,
  parseEnv,
  webEnvSchema,
  workerEnvSchema,
} from '../src';

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  WEB_ORIGIN: 'http://localhost:3000',
};

describe('apiEnvSchema', () => {
  it('applies defaults and derives LOG_LEVEL / cookie security', () => {
    const env = parseEnv(apiEnvSchema, valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.SESSION_COOKIE_SECURE).toBe(false);
    expect(env.WEB_ORIGIN).toEqual(['http://localhost:3000']);
  });

  it('parses boolean strings correctly ("false" must be false)', () => {
    const env = parseEnv(apiEnvSchema, { ...valid, SESSION_COOKIE_SECURE: 'false' });
    expect(env.SESSION_COOKIE_SECURE).toBe(false);
  });

  it('reports every invalid variable without echoing values', () => {
    try {
      parseEnv(apiEnvSchema, {
        ...valid,
        DATABASE_URL: 'mysql://secret-value',
        API_PORT: 'abc',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('API_PORT');
      expect(message).not.toContain('secret-value');
    }
  });

  it('rejects missing required variables', () => {
    expect(() => parseEnv(apiEnvSchema, {})).toThrow(EnvValidationError);
  });

  it('forbids insecure cookies in production', () => {
    expect(() =>
      parseEnv(apiEnvSchema, { ...valid, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' }),
    ).toThrow(/SESSION_COOKIE_SECURE/);
    const prod = parseEnv(apiEnvSchema, {
      ...valid,
      NODE_ENV: 'production',
      EXPORT_LINK_SECRET: 'x'.repeat(32),
    });
    expect(prod.SESSION_COOKIE_SECURE).toBe(true);
    expect(prod.LOG_LEVEL).toBe('info');
  });

  it('requires a real export link secret in production, with a safe default elsewhere', () => {
    expect(() => parseEnv(apiEnvSchema, { ...valid, NODE_ENV: 'production' })).toThrow(
      /EXPORT_LINK_SECRET/,
    );
    expect(() =>
      parseEnv(apiEnvSchema, { ...valid, NODE_ENV: 'production', EXPORT_LINK_SECRET: 'short' }),
    ).toThrow(/at least 32/);
    const dev = parseEnv(apiEnvSchema, valid);
    expect(dev.EXPORT_LINK_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(dev).toMatchObject({ EXPORT_STORAGE_DRIVER: 'fs', EXPORT_LINK_TTL_SECONDS: 60 });
  });

  it('requires bucket settings for the s3 export storage', () => {
    expect(() => parseEnv(apiEnvSchema, { ...valid, EXPORT_STORAGE_DRIVER: 's3' })).toThrow(
      /EXPORT_S3_BUCKET/,
    );
    const env = parseEnv(apiEnvSchema, {
      ...valid,
      EXPORT_STORAGE_DRIVER: 's3',
      EXPORT_S3_BUCKET: 'exports',
      EXPORT_S3_ACCESS_KEY_ID: 'id',
      EXPORT_S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(exportStorageConfig(env)).toMatchObject({
      driver: 's3',
      bucket: 'exports',
      forcePathStyle: true,
    });
    expect(exportStorageConfig(parseEnv(apiEnvSchema, valid))).toMatchObject({ driver: 'fs' });
  });

  it('rejects idle TTL longer than absolute TTL', () => {
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...valid,
        SESSION_IDLE_TTL_HOURS: '48',
        SESSION_ABSOLUTE_TTL_HOURS: '24',
      }),
    ).toThrow(/SESSION_IDLE_TTL_HOURS/);
  });

  it('rejects origins with paths', () => {
    expect(() =>
      parseEnv(apiEnvSchema, { ...valid, WEB_ORIGIN: 'http://localhost:3000/app' }),
    ).toThrow(/WEB_ORIGIN/);
  });
});

describe('workerEnvSchema / webEnvSchema', () => {
  it('validates worker env', () => {
    const env = parseEnv(workerEnvSchema, valid);
    expect(env.WORKER_HEARTBEAT_INTERVAL_MS).toBe(10_000);
  });

  it('validates web env', () => {
    expect(() => parseEnv(webEnvSchema, { API_INTERNAL_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
    expect(
      parseEnv(webEnvSchema, { API_INTERNAL_URL: 'http://localhost:4000' }).API_INTERNAL_URL,
    ).toBe('http://localhost:4000');
  });
});
