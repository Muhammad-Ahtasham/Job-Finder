import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import {
  WORKER_HEARTBEAT_KEY,
  workerHeartbeatSchema,
  type DependencyStatus,
  type ReadyResponse,
} from '@jobfinder/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

const CHECK_TIMEOUT_MS = 2_000;

async function timed(check: () => Promise<string | void>): Promise<DependencyStatus> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const detail = await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { status: 'up', latencyMs: Date.now() - started, ...(detail ? { detail } : {}) };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : 'check failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async ready(): Promise<ReadyResponse> {
    const [database, redis] = await Promise.all([
      timed(async () => {
        await this.prisma.client.$queryRaw`SELECT 1`;
      }),
      timed(async () => {
        await this.redis.ping();
      }),
    ]);
    const worker =
      redis.status === 'up' ? await this.workerStatus() : { status: 'unknown' as const };

    const status =
      database.status === 'down' || redis.status === 'down'
        ? 'error'
        : worker.status === 'up'
          ? 'ok'
          : 'degraded';
    return { status, checks: { database, redis, worker } };
  }

  /** The worker publishes a TTL'd heartbeat; absence means it is not running. */
  private async workerStatus(): Promise<DependencyStatus> {
    try {
      const raw = await this.redis.get(WORKER_HEARTBEAT_KEY);
      if (!raw) return { status: 'down', detail: 'no heartbeat' };
      const heartbeat = workerHeartbeatSchema.parse(JSON.parse(raw));
      return { status: 'up', detail: `last heartbeat ${heartbeat.at}` };
    } catch {
      return { status: 'unknown', detail: 'unreadable heartbeat' };
    }
  }
}
