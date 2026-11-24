import { Global, Module } from '@nestjs/common';
import { DiscoveryQueueService } from './discovery-queue.service';

@Global()
@Module({ providers: [DiscoveryQueueService], exports: [DiscoveryQueueService] })
export class QueueModule {}
