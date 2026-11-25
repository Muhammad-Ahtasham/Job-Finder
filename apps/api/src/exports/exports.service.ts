import {
  ConflictException,
  GoneException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Export as ExportRow, Prisma } from '@jobfinder/database';
import {
  ACTIVE_EXPORT_STATUSES,
  type CreateExportRequest,
  type Export,
  type ExportDownloadLink,
  type ExportListQuery,
  type ExportListResponse,
} from '@jobfinder/contracts';
import { StorageNotFoundError, type ObjectStorage } from '@jobfinder/storage';
import { ENV, type Env } from '../config/env.token';
import { PrismaService } from '../prisma/prisma.service';
import { ExportQueueService } from '../queue/export-queue.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { ExportLinksService } from './export-links.service';
import { OBJECT_STORAGE } from './exports.tokens';

export function toExport(row: ExportRow, now = new Date()): Export {
  const total = row.rowsTotal;
  const percent =
    row.status === 'COMPLETED'
      ? 100
      : total && total > 0
        ? Math.min(99, Math.floor((row.rowsProcessed / total) * 100))
        : 0;
  return {
    id: row.id,
    type: row.type,
    format: row.format,
    scope: row.scope as Export['scope'],
    projectId: row.projectId,
    projectName: row.projectName,
    filters:
      row.filters && typeof row.filters === 'object' && !Array.isArray(row.filters)
        ? (row.filters as Record<string, unknown>)
        : {},
    status: row.status,
    progress: { rowsProcessed: row.rowsProcessed, rowsTotal: total, percent },
    rowCount: row.rowCount,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    downloadable:
      row.status === 'COMPLETED' && !!row.storageKey && (!row.expiresAt || row.expiresAt > now),
  };
}

@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ExportQueueService,
    private readonly links: ExportLinksService,
    @Inject(ENV) private readonly env: Env,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** The export must belong to the caller's workspace; anything else is a plain 404. */
  private async find(workspace: WorkspaceContext, id: string): Promise<ExportRow> {
    const row = await this.prisma.client.export.findFirst({
      where: { id, workspaceId: workspace.id },
    });
    if (!row) throw new NotFoundException('Export not found');
    return row;
  }

  async create(
    workspace: WorkspaceContext,
    userId: string,
    input: CreateExportRequest,
  ): Promise<Export> {
    let projectName: string | null = null;
    if (input.projectId) {
      const project = await this.prisma.client.searchProject.findFirst({
        where: { id: input.projectId, workspaceId: workspace.id },
        select: { name: true },
      });
      if (!project) throw new NotFoundException('Project not found');
      projectName = project.name;
    }

    const active = await this.prisma.client.export.count({
      where: { workspaceId: workspace.id, status: { in: ACTIVE_EXPORT_STATUSES } },
    });
    if (active >= this.env.EXPORT_MAX_ACTIVE_PER_WORKSPACE) {
      throw new HttpException(
        `This workspace already has ${active} exports in progress. Wait for one to finish.`,
        429,
      );
    }

    const filters = input.filters as Record<string, unknown>;
    const row = await this.prisma.client.export.create({
      data: {
        workspaceId: workspace.id,
        requestedById: userId,
        type: input.type,
        format: input.format,
        scope: input.projectId ? 'PROJECT' : Object.keys(filters).length > 0 ? 'FILTERED' : 'ALL',
        projectId: input.projectId ?? null,
        projectName,
        filters: filters as Prisma.InputJsonValue,
      },
    });
    await this.queue.enqueue(row.id);
    return toExport(row);
  }

  async list(workspace: WorkspaceContext, query: ExportListQuery): Promise<ExportListResponse> {
    const rows = await this.prisma.client.export.findMany({
      where: {
        workspaceId: workspace.id,
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const now = new Date();
    return {
      items: page.map((r) => toExport(r, now)),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }

  async get(workspace: WorkspaceContext, id: string): Promise<Export> {
    return toExport(await this.find(workspace, id));
  }

  /** An authorised member gets a link that works for a few seconds without any session. */
  async downloadLink(workspace: WorkspaceContext, id: string): Promise<ExportDownloadLink> {
    const row = await this.find(workspace, id);
    if (row.status === 'QUEUED' || row.status === 'RUNNING') {
      throw new ConflictException('The export is not finished yet');
    }
    if (row.status === 'FAILED') {
      throw new ConflictException(row.errorMessage ?? 'The export failed and has no file');
    }
    if (
      row.status === 'EXPIRED' ||
      !row.storageKey ||
      (row.expiresAt && row.expiresAt <= new Date())
    ) {
      throw new GoneException('The file has expired. Create the export again.');
    }
    const link = this.links.create(row.id);
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  /** Streams the file for a verified link (no session: the signature is the authorisation). */
  async openFile(id: string): Promise<{
    stream: NodeJS.ReadableStream;
    size: number | null;
    fileName: string;
    contentType: string;
  }> {
    const row = await this.prisma.client.export.findUnique({ where: { id } });
    if (!row || row.status !== 'COMPLETED' || !row.storageKey || !row.fileName) {
      throw new NotFoundException('Export not found');
    }
    if (row.expiresAt && row.expiresAt <= new Date())
      throw new GoneException('The file has expired');
    try {
      const { stream, size } = await this.storage.get(row.storageKey);
      return {
        stream,
        size,
        fileName: row.fileName,
        contentType:
          row.format === 'CSV'
            ? 'text/csv; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    } catch (error) {
      if (error instanceof StorageNotFoundError) {
        this.logger.error(`Export ${id} is COMPLETED but its file is missing from storage`);
        throw new GoneException('The file is no longer available');
      }
      throw error;
    }
  }
}
