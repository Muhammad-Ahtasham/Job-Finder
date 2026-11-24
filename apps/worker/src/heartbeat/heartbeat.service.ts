import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { WORKER_HEARTBEAT_KEY, type WorkerHeartbeat } from '@jobfinder/contracts';
import { ENV, type Env } from '../config/env.token';
import { REDIS } from '../infrastructure.module';

/**
 * Publishes a short-lived heartbeat so the API's /health/ready can report whether a
 * worker is running. The key expires on its own if the worker dies without cleanup.
 */
@Injectable()
export class HeartbeatService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HeartbeatService.name);
  private readonly startedAt = new Date().toISOString();
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => void this.beat(), this.env.WORKER_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.redis.del(WORKER_HEARTBEAT_KEY).catch(() => undefined);
  }

  /** TTL is 3× the interval, so two missed beats still count as alive. */
  async beat(): Promise<void> {
    const payload: WorkerHeartbeat = {
      pid: process.pid,
      startedAt: this.startedAt,
      at: new Date().toISOString(),
    };
    const ttlSeconds = Math.max(5, Math.ceil((this.env.WORKER_HEARTBEAT_INTERVAL_MS * 3) / 1000));
    try {
      await this.redis.set(WORKER_HEARTBEAT_KEY, JSON.stringify(payload), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(`Heartbeat failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}
