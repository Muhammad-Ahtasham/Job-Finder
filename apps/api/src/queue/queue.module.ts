import { Global, Module } from '@nestjs/common';
import { DiscoveryQueueService } from './discovery-queue.service';
import { EnrichmentQueueService } from './enrichment-queue.service';
import { JobQueueService } from './job-queue.service';
import { MatchQueueService } from './match-queue.service';

@Global()
@Module({
  providers: [DiscoveryQueueService, EnrichmentQueueService, JobQueueService, MatchQueueService],
  exports: [DiscoveryQueueService, EnrichmentQueueService, JobQueueService, MatchQueueService],
})
export class QueueModule {}
