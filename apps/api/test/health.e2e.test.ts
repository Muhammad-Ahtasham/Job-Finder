import { Inject } from '@nestjs/common';
import request from 'supertest';
import Redis from 'ioredis';
import { WORKER_HEARTBEAT_KEY } from '@jobfinder/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthService } from '../src/health/health.service';
import { createTestApp, type TestContext } from './helpers';

void Inject; // keep import for decorator metadata parity in this test module

let ctx: TestContext;
let redis: Redis;

beforeAll(async () => {
  ctx = await createTestApp();
  redis = new Redis(process.env.REDIS_URL!);
  await redis.del(WORKER_HEARTBEAT_KEY);
});
afterAll(async () => {
  await redis.del(WORKER_HEARTBEAT_KEY);
  redis.disconnect();
  await ctx.app.close();
});

describe('health endpoints', () => {
  it('GET /health/live is ok and unversioned', async () => {
    const response = await request(ctx.server).get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready reports dependency status (degraded without a worker)', async () => {
    await redis.del(WORKER_HEARTBEAT_KEY);
    const response = await request(ctx.server).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('degraded');
    expect(response.body.checks.database.status).toBe('up');
    expect(response.body.checks.redis.status).toBe('up');
    expect(response.body.checks.worker.status).toBe('down');
  });

  it('reports ok once the worker heartbeat exists', async () => {
    const now = new Date().toISOString();
    await redis.set(
      WORKER_HEARTBEAT_KEY,
      JSON.stringify({ pid: 1, startedAt: now, at: now }),
      'EX',
      30,
    );
    const response = await request(ctx.server).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.checks.worker.status).toBe('up');
  });

  it('returns 503 when a critical dependency is down', async () => {
    const failing = new HealthService(
      { client: { $queryRaw: () => Promise.reject(new Error('connection refused')) } } as never,
      {
        ping: () => Promise.resolve('PONG'),
        get: () => Promise.resolve(null),
        status: 'ready',
      } as never,
    );
    const result = await failing.ready();
    expect(result.status).toBe('error');
    expect(result.checks.database).toMatchObject({ status: 'down', detail: 'connection refused' });
    expect(result.checks.redis.status).toBe('up');
  });
});

describe('swagger', () => {
  it('serves the UI and an OpenAPI document describing the auth routes', async () => {
    const ui = await request(ctx.server).get('/docs');
    expect(ui.status).toBe(200);
    expect(ui.headers['content-type']).toMatch(/html/);

    const json = await request(ctx.server).get('/docs/json');
    expect(json.status).toBe(200);
    expect(Object.keys(json.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/register',
        '/api/v1/auth/login',
        '/api/v1/auth/logout',
        '/api/v1/auth/me',
        '/api/v1/workspaces',
        '/health/live',
        '/health/ready',
      ]),
    );
  });
});
