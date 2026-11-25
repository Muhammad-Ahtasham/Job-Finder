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
  companyContactsQuerySchema,
  companyContactsResponseSchema,
  companyReviewListResponseSchema,
  companyReviewSchema,
  companySourcesResponseSchema,
  enrichResponseSchema,
  type CompanyContactsResponse,
  type CompanyReview,
  type CompanySourcesResponse,
  type EnrichResponse,
} from '@jobfinder/contracts';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth } from '../auth/decorators';
import { openApiSchema } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, RequireRole, WorkspaceScoped } from '../workspaces/workspace.decorators';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { EnrichmentService } from './enrichment.service';

@ApiTags('company enrichment')
@ApiCookieAuth()
@WorkspaceScoped()
@Controller({ version: '1' })
export class EnrichmentController {
  constructor(private readonly enrichment: EnrichmentService) {}

  @Post('companies/:id/enrich')
  @RequireRole('MEMBER')
  @HttpCode(202)
  @ApiAcceptedResponse({
    schema: openApiSchema(enrichResponseSchema),
    description:
      'Enrichment queued. If one is already queued/running for this company it is returned with `reused: true`.',
  })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The company was merged into another one' })
  enrich(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EnrichResponse> {
    return this.enrichment.enrich(workspace, auth.user.id, id);
  }

  @Get('companies/:id/sources')
  @ApiOkResponse({
    schema: openApiSchema(companySourcesResponseSchema),
    description:
      'Website decision + evidence, rejected candidates, discovered pages and recent enrichment runs',
  })
  @ApiNotFoundResponse()
  sources(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CompanySourcesResponse> {
    return this.enrichment.sources(workspace, id);
  }

  @Get('companies/:id/contacts')
  @ApiOkResponse({ schema: openApiSchema(companyContactsResponseSchema) })
  @ApiNotFoundResponse()
  contacts(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(companyContactsQuerySchema))
    query: z.infer<typeof companyContactsQuerySchema>,
  ): Promise<CompanyContactsResponse> {
    return this.enrichment.contacts(workspace, id, query);
  }

  @Get('companies/:id/website-reviews')
  @ApiOkResponse({ schema: openApiSchema(companyReviewListResponseSchema) })
  @ApiNotFoundResponse()
  async listReviews(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ items: CompanyReview[] }> {
    return { items: await this.enrichment.listReviews(workspace, id) };
  }

  @Post('website-reviews/:id/approve')
  @RequireRole('MEMBER')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(companyReviewSchema) })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The domain belongs to another company' })
  approve(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CompanyReview> {
    return this.enrichment.approve(workspace, auth.user.id, id);
  }

  @Post('website-reviews/:id/reject')
  @RequireRole('MEMBER')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(companyReviewSchema) })
  @ApiNotFoundResponse()
  reject(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CompanyReview> {
    return this.enrichment.reject(workspace, auth.user.id, id);
  }
}
