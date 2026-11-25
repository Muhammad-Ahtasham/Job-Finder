import { Global, Module } from '@nestjs/common';
import { DiscoveryQueueService } from './discovery-queue.service';
import { EnrichmentQueueService } from './enrichment-queue.service';
import { JobQueueService } from './job-queue.service';

@Global()
@Module({
  providers: [DiscoveryQueueService, EnrichmentQueueService, JobQueueService],
  exports: [DiscoveryQueueService, EnrichmentQueueService, JobQueueService],
})
export class QueueModule {}
