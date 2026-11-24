import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  companyDetailSchema,
  companyListQuerySchema,
  companyListResponseSchema,
  matchReviewSchema,
  reviewListQuerySchema,
  reviewListResponseSchema,
  type CompanyDetail,
  type CompanyListResponse,
  type MatchReview,
  type ReviewListResponse,
} from '@jobfinder/contracts';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth } from '../auth/decorators';
import { openApiSchema } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, RequireRole, WorkspaceScoped } from '../workspaces/workspace.decorators';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { CompaniesService } from './companies.service';
import { ReviewsService } from './reviews.service';

@ApiTags('companies')
@ApiCookieAuth()
@WorkspaceScoped()
@Controller({ version: '1' })
export class CompaniesController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly reviews: ReviewsService,
  ) {}

  @Get('companies')
  @ApiOkResponse({ schema: openApiSchema(companyListResponseSchema) })
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query(new ZodValidationPipe(companyListQuerySchema))
    query: z.infer<typeof companyListQuerySchema>,
  ): Promise<CompanyListResponse> {
    return this.companies.list(workspace, query);
  }

  @Get('companies/:id')
  @ApiOkResponse({ schema: openApiSchema(companyDetailSchema) })
  @ApiNotFoundResponse()
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CompanyDetail> {
    return this.companies.get(workspace, id);
  }

  @ApiTags('reviews')
  @Get('reviews')
  @ApiOkResponse({ schema: openApiSchema(reviewListResponseSchema) })
  listReviews(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query(new ZodValidationPipe(reviewListQuerySchema))
    query: z.infer<typeof reviewListQuerySchema>,
  ): Promise<ReviewListResponse> {
    return this.reviews.list(workspace, query);
  }

  @ApiTags('reviews')
  @Post('reviews/:id/merge')
  @RequireRole('MEMBER')
  @HttpCode(200)
  @ApiOkResponse({
    schema: openApiSchema(companyDetailSchema),
    description: 'The surviving company',
  })
  @ApiConflictResponse({ description: 'Already resolved' })
  merge(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CompanyDetail> {
    return this.reviews.merge(workspace, auth.user.id, id);
  }

  @ApiTags('reviews')
  @Post('reviews/:id/dismiss')
  @RequireRole('MEMBER')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(matchReviewSchema) })
  @ApiConflictResponse({ description: 'Already resolved' })
  dismiss(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MatchReview> {
    return this.reviews.dismiss(workspace, auth.user.id, id);
  }
}
