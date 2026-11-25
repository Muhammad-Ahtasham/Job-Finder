import { Module } from '@nestjs/common';
import { exportStorageConfig } from '@jobfinder/config';
import { createObjectStorage } from '@jobfinder/storage';
import { ENV, type Env } from '../config/env.token';
import { ExportLinksService } from './export-links.service';
import { ExportFileController } from './exports-file.controller';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';
import { OBJECT_STORAGE } from './exports.tokens';

@Module({
  controllers: [ExportsController, ExportFileController],
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ENV],
      useFactory: (env: Env) => createObjectStorage(exportStorageConfig(env)),
    },
    ExportLinksService,
    ExportsService,
  ],
})
export class ExportsModule {}
