import { Test, type TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import type { PrismaClient } from '@jobfinder/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiscoveryModule } from '../src/discovery/discovery.module';
import { DISCOVERY_PROVIDERS } from '../src/discovery/discovery.tokens';
import { RunQueueService } from '../src/discovery/run-queue.service';
import { InfrastructureModule, PRISMA } from '../src/infrastructure.module';
import { createFixture, createRun, waitForTerminalRun } from './discovery-helpers';

let moduleRef: TestingModule;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.flushdb();
  moduleRef = await Test.createTestingModule({ imports: [InfrastructureModule, DiscoveryModule] })
    .overrideProvider(DISCOVERY_PROVIDERS)
    .useValue({
      providers: [],
      skipped: [{ id: 'brave-search', reason: 'BRAVE_SEARCH_STORAGE_RIGHTS not confirmed' }],
    })
    .compile();
  await moduleRef.init();
});

afterAll(async () => {
  await moduleRef.close();
  redis.disconnect();
});

describe('run with no usable provider', () => {
  it('fails visibly instead of silently completing, and reports skipped providers', async () => {
    const prisma = moduleRef.get<PrismaClient>(PRISMA);
    const fixture = await createFixture(prisma, ['anything']);
    const run = await createRun(prisma, fixture);
    await moduleRef.get(RunQueueService).ensurePlanJob(run.id);

    const done = await waitForTerminalRun(prisma, run.id);
    expect(done.status).toBe('FAILED');
    const config = done.config as { planError: string; skippedProviders: { id: string }[] };
    expect(config.planError).toMatch(/No discovery provider/);
    expect(config.skippedProviders.map((p) => p.id)).toEqual(['brave-search']);
    expect(await prisma.discoveryTask.count({ where: { runId: run.id } })).toBe(0);
  });
});
