import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { JobsModule } from '../jobs/jobs.module';
import { MonitoringProcessor } from './monitoring-processor';
import { MonitoringQueueService } from './monitoring-queue.service';
import { NotificationsModule } from './notifications.module';

@Module({
  imports: [EnrichmentModule, JobsModule, NotificationsModule],
  providers: [MonitoringProcessor, MonitoringQueueService],
  exports: [MonitoringProcessor, MonitoringQueueService],
})
export class MonitoringModule {}
