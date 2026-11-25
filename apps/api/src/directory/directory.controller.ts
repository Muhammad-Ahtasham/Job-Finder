import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
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

const companyQuery = new ZodValidationPipe(companyDirectoryQuerySchema);
const jobQuery = new ZodValidationPipe(jobDirectoryQuerySchema);

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
    @Query(companyQuery) query: z.infer<typeof companyDirectoryQuerySchema>,
  ): Promise<CompanyDirectoryResponse> {
    return this.directory.companies(workspace, query);
  }

  @Get('directory/jobs')
  @ApiOkResponse({ schema: openApiSchema(jobDirectoryResponseSchema) })
  jobs(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query(jobQuery) query: z.infer<typeof jobDirectoryQuerySchema>,
  ): Promise<JobDirectoryResponse> {
    return this.directory.jobs(workspace, query);
  }

  @Get('exports/companies.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="companies.csv"')
  @Header('Cache-Control', 'no-store')
  @ApiProduces('text/csv')
  exportCompanies(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query(companyQuery) query: z.infer<typeof companyDirectoryQuerySchema>,
  ): Promise<string> {
    return this.directory.exportCompanies(workspace, query);
  }

  @Get('exports/jobs.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="jobs.csv"')
  @Header('Cache-Control', 'no-store')
  @ApiProduces('text/csv')
  exportJobs(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query(jobQuery) query: z.infer<typeof jobDirectoryQuerySchema>,
  ): Promise<string> {
    return this.directory.exportJobs(workspace, query);
  }
}
