import { Logger, Module } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  AnthropicAiAssistant,
  BraveWebsiteCandidateFinder,
  CrawlerWebsiteEnrichmentProvider,
  PoliteFetcher,
} from '@jobfinder/enrichment';
import { ENV, type Env } from '../config/env.token';
import { REDIS } from '../infrastructure.module';
import { EnrichmentProcessor } from './enrichment-processor';
import { EnrichmentQueueService } from './enrichment-queue.service';
import { ENRICHMENT_PROVIDER, WEBSITE_CANDIDATE_FINDER } from './enrichment.tokens';
import { RedisDomainRateLimiter } from './redis-rate-limiter';

@Module({
  providers: [
    {
      provide: ENRICHMENT_PROVIDER,
      inject: [ENV, REDIS],
      useFactory: (env: Env, redis: Redis) => {
        const logger = new Logger('Enrichment');
        // Sites see who we are and how to reach us; this is also what robots.txt rules key on.
        const contact = env.DISCOVERY_CONTACT ?? 'contact not configured';
        if (!env.DISCOVERY_CONTACT)
          logger.warn('DISCOVERY_CONTACT is not set: crawler User-Agent has no contact');
        const fetcher = new PoliteFetcher({
          userAgent: `JobFinderBot/0.1 (+${contact})`,
          robotsToken: 'JobFinderBot',
          rateLimiter: new RedisDomainRateLimiter(redis, env.ENRICHMENT_DOMAIN_MIN_INTERVAL_MS),
          timeoutMs: env.ENRICHMENT_REQUEST_TIMEOUT_MS,
          maxBytes: env.ENRICHMENT_MAX_RESPONSE_BYTES,
        });
        const ai = env.ANTHROPIC_API_KEY
          ? new AnthropicAiAssistant({
              apiKey: env.ANTHROPIC_API_KEY,
              model: env.ENRICHMENT_AI_MODEL,
            })
          : undefined;
        logger.log(
          `AI assistance for ambiguous cases: ${ai ? env.ENRICHMENT_AI_MODEL : 'disabled'}`,
        );
        return new CrawlerWebsiteEnrichmentProvider({
          fetcher,
          ai,
          maxRequests: env.ENRICHMENT_MAX_REQUESTS_PER_SITE,
        });
      },
    },
    {
      provide: WEBSITE_CANDIDATE_FINDER,
      inject: [ENV],
      // Same licence gate as the Brave discovery provider: search results are stored.
      useFactory: (env: Env) =>
        env.BRAVE_SEARCH_API_KEY && env.BRAVE_SEARCH_STORAGE_RIGHTS
          ? new BraveWebsiteCandidateFinder({ apiKey: env.BRAVE_SEARCH_API_KEY })
          : null,
    },
    EnrichmentProcessor,
    EnrichmentQueueService,
  ],
  exports: [EnrichmentQueueService, EnrichmentProcessor],
})
export class EnrichmentModule {}
