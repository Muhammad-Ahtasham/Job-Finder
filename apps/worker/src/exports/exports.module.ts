import { Module } from '@nestjs/common';
import { exportStorageConfig } from '@jobfinder/config';
import { createObjectStorage } from '@jobfinder/storage';
import { ENV, type Env } from '../config/env.token';
import { ExportProcessor } from './export-processor';
import { ExportQueueService } from './export-queue.service';
import { OBJECT_STORAGE } from './exports.tokens';

@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ENV],
      useFactory: (env: Env) => createObjectStorage(exportStorageConfig(env)),
    },
    ExportProcessor,
    ExportQueueService,
  ],
  exports: [ExportProcessor, ExportQueueService],
})
export class ExportsModule {}
