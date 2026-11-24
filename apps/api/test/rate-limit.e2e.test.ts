import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, newCredentials, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  process.env.AUTH_RATE_LIMIT_PER_MINUTE = '3';
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
  process.env.AUTH_RATE_LIMIT_PER_MINUTE = '1000';
});

describe('auth rate limiting', () => {
  it('throttles repeated login attempts but not other routes', async () => {
    const body = { email: newCredentials().email, password: 'whatever-password' };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await request(ctx.server).post('/api/v1/auth/login').send(body)).status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);

    // Health is exempt from throttling.
    expect((await request(ctx.server).get('/health/live')).status).toBe(200);
  });
});
