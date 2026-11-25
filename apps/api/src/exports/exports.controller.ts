import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiCookieAuth,
  ApiFoundResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  createExportRequestSchema,
  exportDownloadLinkSchema,
  exportDownloadQuerySchema,
  exportListQuerySchema,
  exportListResponseSchema,
  exportSchema,
  type CreateExportRequest,
  type Export,
  type ExportListResponse,
} from '@jobfinder/contracts';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth } from '../auth/decorators';
import { openApiSchema } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, RequireRole, WorkspaceScoped } from '../workspaces/workspace.decorators';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { ExportsService } from './exports.service';

@ApiTags('exports')
@ApiCookieAuth()
@WorkspaceScoped()
@Controller({ path: 'exports', version: '1' })
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @RequireRole('MEMBER')
  @HttpCode(202)
  @ApiBody({ schema: openApiSchema(createExportRequestSchema, 'input') })
  @ApiAcceptedResponse({
    schema: openApiSchema(exportSchema),
    description: 'Queued. Poll GET /exports/:id for progress; the file is built in the background.',
  })
  @ApiNotFoundResponse({ description: 'The project does not exist in this workspace' })
  create(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createExportRequestSchema)) body: CreateExportRequest,
  ): Promise<Export> {
    return this.exports.create(workspace, auth.user.id, body);
  }

  @Get()
  @ApiOkResponse({
    schema: openApiSchema(exportListResponseSchema),
    description: 'Export history, newest first',
  })
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query(new ZodValidationPipe(exportListQuerySchema))
    query: z.infer<typeof exportListQuerySchema>,
  ): Promise<ExportListResponse> {
    return this.exports.list(workspace, query);
  }

  @Get(':id')
  @ApiOkResponse({ schema: openApiSchema(exportSchema) })
  @ApiNotFoundResponse()
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Export> {
    return this.exports.get(workspace, id);
  }

  @Get(':id/download')
  @ApiFoundResponse({ description: 'Redirects to a short-lived link to the file' })
  @ApiOkResponse({
    schema: openApiSchema(exportDownloadLinkSchema),
    description: 'With ?mode=json',
  })
  @ApiNotFoundResponse()
  async download(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(exportDownloadQuerySchema))
    query: z.infer<typeof exportDownloadQuerySchema>,
    @Res() response: Response,
  ): Promise<void> {
    const link = await this.exports.downloadLink(workspace, id);
    response.setHeader('Cache-Control', 'no-store');
    if (query.mode === 'json') response.json(link);
    else response.redirect(302, link.url);
  }
}
