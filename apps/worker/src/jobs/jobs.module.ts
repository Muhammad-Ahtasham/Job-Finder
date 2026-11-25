import { Module } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  AnthropicJobExtractor,
  AshbyProvider,
  ATSDetectionService,
  CareerPageDiscoveryService,
  GenericHtmlJobProvider,
  GreenhouseProvider,
  JobProviderRegistry,
  LeverProvider,
} from '@jobfinder/jobs';
import type { PageFetcher } from '@jobfinder/enrichment';
import { ENV, type Env } from '../config/env.token';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { PAGE_FETCHER } from '../enrichment/enrichment.tokens';
import { REDIS } from '../infrastructure.module';
import { JobDiscoveryProcessor } from './job-discovery-processor';
import { JobQueueService } from './job-queue.service';
import { CAREER_DISCOVERY, JOB_AI_EXTRACTOR, JOB_PROVIDER_REGISTRY } from './jobs.tokens';
import { RedisDomainRateLimiter } from '../enrichment/redis-rate-limiter';

@Module({
  imports: [EnrichmentModule],
  providers: [
    {
      provide: JOB_PROVIDER_REGISTRY,
      inject: [ENV, REDIS, PAGE_FETCHER],
      useFactory: (env: Env, redis: Redis, fetcher: PageFetcher) => {
        const api = {
          userAgent: `JobFinderBot/0.1 (+${env.DISCOVERY_CONTACT ?? 'contact not configured'})`,
          // One budget per vendor API host, shared by every worker replica.
          rateLimiter: new RedisDomainRateLimiter(
            redis,
            env.JOBS_API_MIN_INTERVAL_MS,
            'jf:jobs:rl:',
          ),
        };
        return new JobProviderRegistry([
          new GreenhouseProvider(api),
          new LeverProvider(api),
          new AshbyProvider(api),
          new GenericHtmlJobProvider(fetcher),
        ]);
      },
    },
    {
      provide: CAREER_DISCOVERY,
      inject: [ENV, JOB_PROVIDER_REGISTRY, PAGE_FETCHER],
      useFactory: (env: Env, registry: JobProviderRegistry, fetcher: PageFetcher) =>
        new CareerPageDiscoveryService({
          fetcher,
          ats: new ATSDetectionService(registry),
          maxFetches: env.JOBS_MAX_CAREER_FETCHES,
        }),
    },
    {
      provide: JOB_AI_EXTRACTOR,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.ANTHROPIC_API_KEY
          ? new AnthropicJobExtractor({
              apiKey: env.ANTHROPIC_API_KEY,
              model: env.ENRICHMENT_AI_MODEL,
            })
          : null,
    },
    JobDiscoveryProcessor,
    JobQueueService,
  ],
  exports: [JobQueueService, JobDiscoveryProcessor],
})
export class JobsModule {}
