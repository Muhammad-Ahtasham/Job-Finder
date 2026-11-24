import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  discoveryResultListResponseSchema,
  paginationQuerySchema,
  runListResponseSchema,
  runProgressSchema,
  runSchema,
  type DiscoveryResultListResponse,
  type PaginationQuery,
  type Run,
  type RunListResponse,
  type RunProgress,
} from '@jobfinder/contracts';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth } from '../auth/decorators';
import { openApiSchema } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, RequireRole, WorkspaceScoped } from '../workspaces/workspace.decorators';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { assertValidIdempotencyKey, RunsService } from './runs.service';

@ApiTags('runs')
@ApiCookieAuth()
@WorkspaceScoped()
@Controller({ version: '1' })
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post('projects/:projectId/runs')
  @RequireRole('MEMBER')
  @HttpCode(202)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Repeating a request with the same key returns the same run.',
  })
  @ApiAcceptedResponse({ schema: openApiSchema(runSchema), description: 'Run created and queued' })
  @ApiConflictResponse({ description: 'A run is already in progress for the project' })
  start(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Run> {
    return this.runs.start(
      workspace,
      auth.user.id,
      projectId,
      assertValidIdempotencyKey(idempotencyKey),
    );
  }

  @Get('projects/:projectId/runs')
  @ApiOkResponse({ schema: openApiSchema(runListResponseSchema) })
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<RunListResponse> {
    return this.runs.listForProject(workspace, projectId);
  }

  @Get('runs/:id')
  @ApiOkResponse({ schema: openApiSchema(runSchema) })
  @ApiNotFoundResponse()
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Run> {
    return this.runs.get(workspace, id);
  }

  @Get('runs/:id/progress')
  @ApiOkResponse({ schema: openApiSchema(runProgressSchema) })
  @ApiNotFoundResponse()
  progress(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RunProgress> {
    return this.runs.progress(workspace, id);
  }

  @Get('runs/:id/results')
  @ApiOkResponse({ schema: openApiSchema(discoveryResultListResponseSchema) })
  results(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<DiscoveryResultListResponse> {
    return this.runs.results(workspace, id, query);
  }

  @Post('runs/:id/cancel')
  @RequireRole('MEMBER')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(runSchema) })
  @ApiConflictResponse({ description: 'The run already finished' })
  cancel(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Run> {
    return this.runs.cancel(workspace, id);
  }
}
