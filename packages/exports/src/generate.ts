import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { PrismaClient } from '@jobfinder/database';
import type { Cell } from './sanitize';
import {
  COMPANY_COLUMNS,
  countCompanies,
  countJobs,
  JOB_COLUMNS,
  readCompanies,
  readJobs,
  type ExportColumn,
} from './rows';
import type { CompanyFilters, JobFilters } from './queries';
import { openCsv, openXlsx, type RowSink } from './writers';

export class ExportTooLargeError extends Error {
  constructor(
    readonly total: number,
    readonly limit: number,
  ) {
    super(`The export has ${total} rows; the limit is ${limit}. Narrow the filters.`);
    this.name = 'ExportTooLargeError';
  }
}

export const CONTENT_TYPES = {
  CSV: 'text/csv; charset=utf-8',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export type ExportRequest =
  { type: 'COMPANIES'; filters: CompanyFilters } | { type: 'JOBS'; filters: JobFilters };

export interface GenerateOptions {
  prisma: PrismaClient;
  workspaceId: string;
  request: ExportRequest;
  format: 'CSV' | 'XLSX';
  batchSize: number;
  maxRows: number;
  /** Called with the total once, then after every batch. */
  onProgress: (processed: number, total: number) => Promise<void> | void;
}

export interface GeneratedFile {
  /** A temporary file; the caller uploads it and then calls `cleanup`. */
  path: string;
  rowCount: number;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  extension: 'csv' | 'xlsx';
  cleanup: () => Promise<void>;
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Builds the export file in a temp directory, streaming batch by batch. The filters are applied
 * by the same query builders as the tables, always inside `workspaceId`.
 */
export async function generateExportFile(options: GenerateOptions): Promise<GeneratedFile> {
  const { prisma, workspaceId, request, format } = options;
  const total =
    request.type === 'COMPANIES'
      ? await countCompanies(prisma, workspaceId, request.filters)
      : await countJobs(prisma, workspaceId, request.filters);
  if (total > options.maxRows) throw new ExportTooLargeError(total, options.maxRows);
  await options.onProgress(0, total);

  const dir = await mkdtemp(join(tmpdir(), 'jf-export-'));
  const extension = format === 'CSV' ? 'csv' : 'xlsx';
  const path = join(dir, `export.${extension}`);
  const cleanup = () => rm(dir, { recursive: true, force: true });

  try {
    const columns = (
      request.type === 'COMPANIES' ? COMPANY_COLUMNS : JOB_COLUMNS
    ) as ExportColumn<unknown>[];
    const sink: RowSink =
      format === 'CSV'
        ? await openCsv(
            path,
            columns.map((c) => c.header),
          )
        : await openXlsx(path, request.type === 'COMPANIES' ? 'Companies' : 'Jobs', columns);

    let processed = 0;
    const batches: AsyncGenerator<unknown[]> =
      request.type === 'COMPANIES'
        ? readCompanies(prisma, workspaceId, request.filters, options.batchSize)
        : readJobs(prisma, workspaceId, request.filters, options.batchSize);
    try {
      for await (const batch of batches) {
        for (const row of batch) {
          // Never write past the limit even if rows were added since the count.
          if (processed >= options.maxRows) break;
          await sink.write(columns.map((c): Cell => c.value(row)));
          processed += 1;
        }
        await options.onProgress(processed, Math.max(total, processed));
      }
    } finally {
      await sink.close();
    }

    const info = await stat(path);
    return {
      path,
      rowCount: processed,
      sizeBytes: info.size,
      sha256: await fileDigest(path),
      contentType: CONTENT_TYPES[format],
      extension,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
