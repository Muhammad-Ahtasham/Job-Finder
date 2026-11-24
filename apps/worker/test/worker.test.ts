import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAINTENANCE_JOBS,
  QUEUES,
  WORKER_HEARTBEAT_KEY,
  workerHeartbeatSchema,
} from '@jobfinder/contracts';
import type { PrismaClient } from '@jobfinder/database';
import { HeartbeatService } from '../src/heartbeat/heartbeat.service';
import { InfrastructureModule, PRISMA } from '../src/infrastructure.module';
import { MaintenanceService } from '../src/maintenance/maintenance.service';

let moduleRef: TestingModule;
let redis: Redis;
let prisma: PrismaClient;
let queue: Queue;

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.flushdb(); // Redis db 14 is reserved for worker tests
  moduleRef = await Test.createTestingModule({
    imports: [InfrastructureModule],
    providers: [HeartbeatService, MaintenanceService],
  }).compile();
  await moduleRef.init();
  prisma = moduleRef.get<PrismaClient>(PRISMA);
  queue = new Queue(QUEUES.MAINTENANCE, { connection: redis.duplicate() });
});

afterAll(async () => {
  await queue.close();
  await moduleRef.close();
  redis.disconnect();
});

describe('worker ↔ Redis', () => {
  it('connects to Redis and publishes a TTL-bound heartbeat', async () => {
    expect(await redis.ping()).toBe('PONG');
    const raw = await redis.get(WORKER_HEARTBEAT_KEY);
    expect(raw).not.toBeNull();
    const heartbeat = workerHeartbeatSchema.parse(JSON.parse(raw!));
    expect(heartbeat.pid).toBe(process.pid);
    const ttl = await redis.ttl(WORKER_HEARTBEAT_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });

  it('refreshes the heartbeat on its interval', async () => {
    const first = workerHeartbeatSchema.parse(JSON.parse((await redis.get(WORKER_HEARTBEAT_KEY))!));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const second = workerHeartbeatSchema.parse(
      JSON.parse((await redis.get(WORKER_HEARTBEAT_KEY))!),
    );
    expect(Date.parse(second.at)).toBeGreaterThan(Date.parse(first.at));
  });

  it('registers the recurring maintenance scheduler exactly once', async () => {
    const schedulers = await queue.getJobSchedulers();
    expect(
      schedulers.filter((s) => s.name === MAINTENANCE_JOBS.PURGE_EXPIRED_SESSIONS),
    ).toHaveLength(1);
  });
});

describe('maintenance queue', () => {
  it('consumes a purge job and deletes only expired sessions', async () => {
    const user = await prisma.user.create({
      data: {
        email: `worker-${randomUUID()}@example.test`,
        name: 'Worker Test',
        passwordHash: 'x',
      },
    });
    const live = await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const dead = await prisma.session.create({
      data: { userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 1000) },
    });

    await queue.add(MAINTENANCE_JOBS.PURGE_EXPIRED_SESSIONS, {});

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await prisma.session.findUnique({ where: { id: dead.id } }))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await prisma.session.findUnique({ where: { id: dead.id } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: live.id } })).not.toBeNull();

    await prisma.user.delete({ where: { id: user.id } });
  });
});
