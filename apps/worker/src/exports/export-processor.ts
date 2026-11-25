import { createReadStream } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Export, PrismaClient } from '@jobfinder/database';
import { companyExportFiltersSchema, jobExportFiltersSchema } from '@jobfinder/contracts';
import { ExportTooLargeError, generateExportFile, type ExportRequest } from '@jobfinder/exports';
import type { ObjectStorage } from '@jobfinder/storage';
import { ENV, type Env } from '../config/env.token';
import { PRISMA } from '../infrastructure.module';
import { OBJECT_STORAGE } from './exports.tokens';

const DAY_MS = 86_400_000;
const TERMINAL = ['COMPLETED', 'FAILED', 'EXPIRED'];

/** A failure that retrying cannot fix: the export is marked FAILED at once. */
class PermanentExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * Builds one export file and stores it. Progress is persisted as rows are written, the file goes
 * to object storage (never the database), and a failure leaves a clear message on the record.
 */
@Injectable()
export class ExportProcessor {
  private readonly logger = new Logger(ExportProcessor.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async process(exportId: string): Promise<void> {
    const claimed = await this.claim(exportId);
    if (!claimed) return;
    try {
      await this.run(claimed);
    } catch (error) {
      if (error instanceof ExportTooLargeError) {
        await this.markFailed(exportId, 'EXPORT_TOO_LARGE', error.message);
        return;
      }
      if (error instanceof PermanentExportError) {
        await this.markFailed(exportId, error.code, error.message);
        return;
      }
      throw error; // transient: BullMQ retries; the last failure is recorded by the queue service
    }
  }

  /** QUEUED/RUNNING → RUNNING, atomically; a finished export is never started again. */
  private async claim(exportId: string): Promise<Export | null> {
    const now = new Date();
    const result = await this.prisma.export.updateMany({
      where: { id: exportId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'RUNNING',
        startedAt: now,
        attempts: { increment: 1 },
        rowsProcessed: 0,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (result.count === 0) return null;
    return this.prisma.export.findUnique({ where: { id: exportId } });
  }

  private async toRequest(
    row: Export,
  ): Promise<{ request: ExportRequest; project: string | null }> {
    let projectName: string | null = null;
    if (row.projectId) {
      // The project must still exist, in THIS workspace (a deleted one cannot be exported).
      const project = await this.prisma.searchProject.findFirst({
        where: { id: row.projectId, workspaceId: row.workspaceId },
        select: { name: true },
      });
      if (!project) {
        throw new PermanentExportError(
          'PROJECT_NOT_FOUND',
          'The project of this export no longer exists',
        );
      }
      projectName = project.name;
    }
    // The stored filters were validated when the export was requested; validate again anyway.
    if (row.type === 'COMPANIES') {
      const filters = companyExportFiltersSchema.safeParse(row.filters);
      if (!filters.success)
        throw new PermanentExportError('INVALID_FILTERS', 'The stored filters are invalid');
      return {
        request: {
          type: 'COMPANIES',
          filters: { ...filters.data, projectId: row.projectId ?? undefined },
        },
        project: projectName,
      };
    }
    const filters = jobExportFiltersSchema.safeParse(row.filters);
    if (!filters.success)
      throw new PermanentExportError('INVALID_FILTERS', 'The stored filters are invalid');
    return {
      request: {
        type: 'JOBS',
        filters: { ...filters.data, projectId: row.projectId ?? undefined },
      },
      project: projectName,
    };
  }

  private async run(row: Export): Promise<void> {
    const { request, project } = await this.toRequest(row);

    const file = await generateExportFile({
      prisma: this.prisma,
      workspaceId: row.workspaceId,
      request,
      format: row.format,
      batchSize: this.env.EXPORT_BATCH_SIZE,
      maxRows: this.env.EXPORT_MAX_ROWS,
      onProgress: async (processed, total) => {
        await this.prisma.export.updateMany({
          where: { id: row.id, status: 'RUNNING' },
          data: { rowsProcessed: processed, rowsTotal: total },
        });
      },
    });

    try {
      const day = new Date().toISOString().slice(0, 10);
      const fileName = `${[row.type.toLowerCase(), project ? slug(project) : null, day]
        .filter(Boolean)
        .join('-')}.${file.extension}`;
      // Namespaced by workspace; the key is never shown to users.
      const storageKey = `exports/${row.workspaceId}/${row.id}.${file.extension}`;
      await this.storage.put(storageKey, createReadStream(file.path), {
        contentType: file.contentType,
      });

      const finished = new Date();
      await this.prisma.export.updateMany({
        where: { id: row.id, status: 'RUNNING' },
        data: {
          status: 'COMPLETED',
          rowCount: file.rowCount,
          rowsProcessed: file.rowCount,
          rowsTotal: file.rowCount,
          fileName,
          storageKey,
          sizeBytes: file.sizeBytes,
          checksum: file.sha256,
          finishedAt: finished,
          expiresAt: new Date(finished.getTime() + this.env.EXPORT_RETENTION_DAYS * DAY_MS),
        },
      });
      this.logger.log(`Export ${row.id}: ${file.rowCount} rows, ${file.sizeBytes} bytes`);
    } finally {
      await file.cleanup();
    }
  }

  async markFailed(exportId: string, code: string, message: string): Promise<void> {
    await this.prisma.export.updateMany({
      where: { id: exportId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        errorCode: code,
        errorMessage: message.slice(0, 500),
        finishedAt: new Date(),
      },
    });
  }

  /** A retry is coming: show that, not a stale RUNNING. */
  async markRetrying(exportId: string, error: Error): Promise<void> {
    await this.prisma.export.updateMany({
      where: { id: exportId, status: 'RUNNING' },
      data: { status: 'QUEUED', errorCode: 'RETRYING', errorMessage: error.message.slice(0, 500) },
    });
  }

  // ---------------------------------------------------------------- retention

  /** Deletes the files of exports past their retention; the history record stays. */
  async expireOld(now = new Date()): Promise<number> {
    const due = await this.prisma.export.findMany({
      where: { status: 'COMPLETED', expiresAt: { lte: now } },
      select: { id: true, storageKey: true },
      take: 100,
    });
    let expired = 0;
    for (const item of due) {
      try {
        if (item.storageKey) await this.storage.delete(item.storageKey);
        await this.prisma.export.update({
          where: { id: item.id },
          data: { status: 'EXPIRED', storageKey: null },
        });
        expired += 1;
      } catch (error) {
        // Keep the record COMPLETED so the next sweep tries the deletion again.
        this.logger.warn(
          `Could not delete the file of export ${item.id}: ${(error as Error).message}`,
        );
      }
    }
    return expired;
  }

  static isTerminal = (status: string) => TERMINAL.includes(status);
}
