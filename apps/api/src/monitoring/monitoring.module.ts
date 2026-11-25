import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [MonitoringController],
  providers: [MonitoringService, NotificationsService],
})
export class MonitoringModule {}
