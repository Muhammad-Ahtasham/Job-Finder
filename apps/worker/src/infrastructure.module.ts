import { Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@jobfinder/database';
import { loadWorkerEnv } from '@jobfinder/config';
import Redis from 'ioredis';
import { ENV, type Env } from './config/env.token';

export const REDIS = Symbol('WORKER_REDIS');
export const PRISMA = Symbol('WORKER_PRISMA');

@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
    this.redis.disconnect();
  }
}

/** Validated env + the shared Redis and Prisma connections for worker processors. */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadWorkerEnv() },
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env) => {
        const logger = new Logger('Redis');
        // BullMQ workers require maxRetriesPerRequest: null (blocking commands).
        const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
        redis.on('error', (error) => logger.warn(`Redis error: ${error.message}`));
        redis.on('ready', () => logger.log('Redis connection ready'));
        return redis;
      },
    },
    {
      provide: PRISMA,
      inject: [ENV],
      useFactory: (env: Env) => createPrismaClient(env.DATABASE_URL),
    },
    InfrastructureLifecycle,
  ],
  exports: [ENV, REDIS, PRISMA],
})
export class InfrastructureModule {}
