import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  jobListQuerySchema,
  jobListResponseSchema,
  jobRefreshResponseSchema,
  jobSourcesResponseSchema,
  type JobListResponse,
  type JobRefreshResponse,
  type JobSourcesResponse,
} from '@jobfinder/contracts';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth } from '../auth/decorators';
import { openApiSchema } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, RequireRole, WorkspaceScoped } from '../workspaces/workspace.decorators';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@ApiCookieAuth()
@WorkspaceScoped()
@Controller({ version: '1' })
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('companies/:id/jobs/refresh')
  @RequireRole('MEMBER')
  @HttpCode(202)
  @ApiAcceptedResponse({
    schema: openApiSchema(jobRefreshResponseSchema),
    description:
      'Career page discovery and job fetching queued. An already queued/running run is returned with `reused: true`.',
  })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The company was merged into another one' })
  refresh(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobRefreshResponse> {
    return this.jobs.refresh(workspace, auth.user.id, id);
  }

  @Get('companies/:id/jobs')
  @ApiOkResponse({ schema: openApiSchema(jobListResponseSchema) })
  @ApiNotFoundResponse()
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(jobListQuerySchema)) query: z.infer<typeof jobListQuerySchema>,
  ): Promise<JobListResponse> {
    return this.jobs.list(workspace, id, query);
  }

  @Get('companies/:id/job-sources')
  @ApiOkResponse({
    schema: openApiSchema(jobSourcesResponseSchema),
    description:
      'Career pages, the ATS boards and pages jobs come from, each source recent checks (failed vs. no openings), and whether vacancies are actually known',
  })
  @ApiNotFoundResponse()
  sources(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobSourcesResponse> {
    return this.jobs.sources(workspace, id);
  }
}
