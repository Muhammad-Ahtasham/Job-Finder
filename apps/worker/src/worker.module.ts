import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { loadWorkerEnv } from '@jobfinder/config';
import { HeartbeatService } from './heartbeat/heartbeat.service';
import { InfrastructureModule } from './infrastructure.module';
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
  ],
  providers: [HeartbeatService, MaintenanceService],
})
export class WorkerModule {}
