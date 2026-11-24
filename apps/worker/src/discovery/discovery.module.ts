import { Logger, Module } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  createProviders,
  DefaultCompanyDeduplicationService,
  DefaultCompanyNormalizationService,
  type ProviderSet,
} from '@jobfinder/discovery';
import { ENV, type Env } from '../config/env.token';
import { REDIS } from '../infrastructure.module';
import { CandidatePersister } from './candidate-persister';
import { DEDUPLICATOR, DISCOVERY_PROVIDERS, NORMALIZER } from './discovery.tokens';
import { ProviderQueuesService } from './provider-queues.service';
import { ProviderRegistry } from './provider-registry';
import { RedisProviderCache } from './redis-provider-cache';
import { DiscoveryReconciler } from './reconciler';
import { RunFinalizer } from './run-finalizer';
import { RunPlanner } from './run-planner';
import { RunQueueService } from './run-queue.service';
import { DiscoveryTaskRunner } from './task-runner';

@Module({
  providers: [
    {
      provide: DISCOVERY_PROVIDERS,
      inject: [ENV, REDIS],
      useFactory: (env: Env, redis: Redis): ProviderSet => {
        const logger = new Logger('DiscoveryProviders');
        const set = createProviders({
          enabled: env.DISCOVERY_PROVIDERS,
          allowFixtures: env.NODE_ENV !== 'production',
          // OSM's policy requires clients to identify themselves.
          userAgent: `JobFinderDiscovery/0.1 (${env.DISCOVERY_CONTACT ?? 'self-hosted; set DISCOVERY_CONTACT'})`,
          brave: {
            apiKey: env.BRAVE_SEARCH_API_KEY,
            storageRightsConfirmed: env.BRAVE_SEARCH_STORAGE_RIGHTS,
            requestsPerSecond: env.BRAVE_SEARCH_RPS,
            pagesPerQuery: env.BRAVE_SEARCH_PAGES,
          },
          overpass: {
            endpoint: env.OVERPASS_API_URL,
            minIntervalMs: env.OVERPASS_MIN_INTERVAL_MS,
            cache: new RedisProviderCache(redis),
          },
        });
        for (const provider of set.providers) logger.log(`Enabled provider: ${provider.id}`);
        for (const skipped of set.skipped)
          logger.warn(`Provider "${skipped.id}" NOT enabled: ${skipped.reason}`);
        return set;
      },
    },
    {
      provide: ProviderRegistry,
      inject: [DISCOVERY_PROVIDERS],
      useFactory: (set: ProviderSet) => new ProviderRegistry(set.providers),
    },
    { provide: NORMALIZER, useValue: new DefaultCompanyNormalizationService() },
    { provide: DEDUPLICATOR, useValue: new DefaultCompanyDeduplicationService() },
    CandidatePersister,
    RunFinalizer,
    DiscoveryTaskRunner,
    ProviderQueuesService,
    RunPlanner,
    RunQueueService,
    DiscoveryReconciler,
  ],
  exports: [DiscoveryReconciler],
})
export class DiscoveryModule {}
