import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { loadWorkerEnv } from '@jobfinder/config';
import { DiscoveryModule } from './discovery/discovery.module';
import { EnrichmentModule } from './enrichment/enrichment.module';
import { ExportsModule } from './exports/exports.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { JobsModule } from './jobs/jobs.module';
import { HeartbeatService } from './heartbeat/heartbeat.service';
import { InfrastructureModule } from './infrastructure.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { MaintenanceService } from './maintenance/maintenance.service';

const env = loadWorkerEnv();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        genReqId: () => randomUUID(),
        transport:
          env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
            : undefined,
      },
    }),
    InfrastructureModule,
    DiscoveryModule,
    EnrichmentModule,
    JobsModule,
    IntelligenceModule,
    ExportsModule,
    MonitoringModule,
  ],
  providers: [HeartbeatService, MaintenanceService],
})
export class WorkerModule {}
