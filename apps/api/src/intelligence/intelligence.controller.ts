import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  jobDetailSchema,
  jobHistoryQuerySchema,
  jobHistoryResponseSchema,
  jobSearchQuerySchema,
  jobSearchResponseSchema,
  matchListQuerySchema,
  matchListResponseSchema,
  matchPreferencesSchema,
  matchRefreshResponseSchema,
  updateMatchPreferencesRequestSchema,
  type JobDetail,
  type JobHistoryResponse,
  type JobSearchResponse,
  type MatchListResponse,
  type MatchPreferences,
  type UpdateMatchPreferencesRequest,
} from '@jobfinder/contracts';
import type { z } from 'zod';
import { openApiSchema } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, RequireRole, WorkspaceScoped } from '../workspaces/workspace.decorators';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { IntelligenceService } from './intelligence.service';

@ApiTags('jobs')
@ApiCookieAuth()
@WorkspaceScoped()
@Controller({ version: '1' })
export class IntelligenceController {
  constructor(private readonly intelligence: IntelligenceService) {}

  @Get('jobs')
  @ApiOkResponse({
    schema: openApiSchema(jobSearchResponseSchema),
    description:
      'Structured jobs across the workspace, newest first. Filter by status, skill, seniority, ...',
  })
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query(new ZodValidationPipe(jobSearchQuerySchema)) query: z.infer<typeof jobSearchQuerySchema>,
  ): Promise<JobSearchResponse> {
    return this.intelligence.searchJobs(workspace, query);
  }

  @Get('jobs/:id')
  @ApiOkResponse({ schema: openApiSchema(jobDetailSchema) })
  @ApiNotFoundResponse()
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobDetail> {
    return this.intelligence.getJob(workspace, id);
  }

  @Get('jobs/:id/history')
  @ApiOkResponse({
    schema: openApiSchema(jobHistoryResponseSchema),
    description:
      'Every sighting, change, missing-from-listing and status change of the job, newest first',
  })
  @ApiNotFoundResponse()
  history(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(jobHistoryQuerySchema))
    query: z.infer<typeof jobHistoryQuerySchema>,
  ): Promise<JobHistoryResponse> {
    return this.intelligence.history(workspace, id, query);
  }

  @Get('projects/:id/matches')
  @ApiOkResponse({
    schema: openApiSchema(matchListResponseSchema),
    description:
      'Jobs scored for the project, best first, with matched/missing skills and an explanation',
  })
  @ApiNotFoundResponse()
  matches(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(matchListQuerySchema)) query: z.infer<typeof matchListQuerySchema>,
  ): Promise<MatchListResponse> {
    return this.intelligence.matches(workspace, id, query);
  }

  @Post('projects/:id/matches/refresh')
  @RequireRole('MEMBER')
  @HttpCode(202)
  @ApiAcceptedResponse({ schema: openApiSchema(matchRefreshResponseSchema) })
  @ApiNotFoundResponse()
  refresh(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ queued: boolean }> {
    return this.intelligence.refreshMatches(workspace, id);
  }

  @Get('projects/:id/matching-preferences')
  @ApiOkResponse({ schema: openApiSchema(matchPreferencesSchema) })
  @ApiNotFoundResponse()
  preferences(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MatchPreferences> {
    return this.intelligence.preferences(workspace, id);
  }

  @Put('projects/:id/matching-preferences')
  @RequireRole('MEMBER')
  @ApiBody({ schema: openApiSchema(updateMatchPreferencesRequestSchema, 'input') })
  @ApiOkResponse({
    schema: openApiSchema(matchPreferencesSchema),
    description: 'Omitted fields keep their value. Matches are recalculated in the background.',
  })
  @ApiNotFoundResponse()
  updatePreferences(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateMatchPreferencesRequestSchema))
    body: UpdateMatchPreferencesRequest,
  ): Promise<MatchPreferences> {
    return this.intelligence.updatePreferences(workspace, id, body);
  }
}
