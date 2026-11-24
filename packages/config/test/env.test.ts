import { describe, expect, it } from 'vitest';
import { apiEnvSchema, EnvValidationError, parseEnv, webEnvSchema, workerEnvSchema } from '../src';

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
    const prod = parseEnv(apiEnvSchema, { ...valid, NODE_ENV: 'production' });
    expect(prod.SESSION_COOKIE_SECURE).toBe(true);
    expect(prod.LOG_LEVEL).toBe('info');
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
