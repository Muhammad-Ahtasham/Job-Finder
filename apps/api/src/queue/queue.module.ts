import { Global, Module } from '@nestjs/common';
import { DiscoveryQueueService } from './discovery-queue.service';
import { EnrichmentQueueService } from './enrichment-queue.service';

@Global()
@Module({
  providers: [DiscoveryQueueService, EnrichmentQueueService],
  exports: [DiscoveryQueueService, EnrichmentQueueService],
})
export class QueueModule {}
