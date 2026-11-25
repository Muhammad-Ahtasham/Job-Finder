import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  companyDirectoryQuerySchema,
  companyDirectoryResponseSchema,
  dashboardSummarySchema,
  directoryFacetsSchema,
  jobDirectoryQuerySchema,
  jobDirectoryResponseSchema,
  type CompanyDirectoryResponse,
  type DashboardSummary,
  type DirectoryFacets,
  type JobDirectoryResponse,
} from '@jobfinder/contracts';
import type { z } from 'zod';
import { openApiSchema } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, WorkspaceScoped } from '../workspaces/workspace.decorators';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { DirectoryService } from './directory.service';

/** Read models for the dashboard UI: server-side filtering, sorting and offset pagination. */
@ApiTags('directory')
@ApiCookieAuth()
@WorkspaceScoped()
@Controller({ version: '1' })
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get('dashboard/summary')
  @ApiOkResponse({ schema: openApiSchema(dashboardSummarySchema) })
  summary(@CurrentWorkspace() workspace: WorkspaceContext): Promise<DashboardSummary> {
    return this.directory.summary(workspace);
  }

  @Get('directory/facets')
  @ApiOkResponse({
    schema: openApiSchema(directoryFacetsSchema),
    description:
      'Cities, industries and role families that exist in the workspace (filter options)',
  })
  facets(@CurrentWorkspace() workspace: WorkspaceContext): Promise<DirectoryFacets> {
    return this.directory.facets(workspace);
  }

  @Get('directory/companies')
  @ApiOkResponse({ schema: openApiSchema(companyDirectoryResponseSchema) })
  companies(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query(new ZodValidationPipe(companyDirectoryQuerySchema))
    query: z.infer<typeof companyDirectoryQuerySchema>,
  ): Promise<CompanyDirectoryResponse> {
    return this.directory.companies(workspace, query);
  }

  @Get('directory/jobs')
  @ApiOkResponse({ schema: openApiSchema(jobDirectoryResponseSchema) })
  jobs(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query(new ZodValidationPipe(jobDirectoryQuerySchema))
    query: z.infer<typeof jobDirectoryQuerySchema>,
  ): Promise<JobDirectoryResponse> {
    return this.directory.jobs(workspace, query);
  }
}
