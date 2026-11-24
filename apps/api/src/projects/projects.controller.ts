import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  createProjectRequestSchema,
  projectListResponseSchema,
  projectSchema,
  updateProjectRequestSchema,
  type CreateProjectRequest,
  type Project,
  type ProjectListResponse,
  type UpdateProjectRequest,
} from '@jobfinder/contracts';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth } from '../auth/decorators';
import { openApiSchema } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, RequireRole, WorkspaceScoped } from '../workspaces/workspace.decorators';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { ProjectsService } from './projects.service';

/** Thin HTTP layer: workspace + role come from guards, rules live in ProjectsService. */
@ApiTags('projects')
@ApiCookieAuth()
@WorkspaceScoped()
@Controller({ path: 'projects', version: '1' })
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @RequireRole('MEMBER')
  @ApiBody({ schema: openApiSchema(createProjectRequestSchema, 'input') })
  @ApiCreatedResponse({ schema: openApiSchema(projectSchema) })
  @ApiConflictResponse({ description: 'A project with this name already exists' })
  create(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createProjectRequestSchema)) body: CreateProjectRequest,
  ): Promise<Project> {
    return this.projects.create(workspace, auth.user.id, body);
  }

  @Get()
  @ApiOkResponse({ schema: openApiSchema(projectListResponseSchema) })
  list(@CurrentWorkspace() workspace: WorkspaceContext): Promise<ProjectListResponse> {
    return this.projects.list(workspace);
  }

  @Get(':id')
  @ApiOkResponse({ schema: openApiSchema(projectSchema) })
  @ApiNotFoundResponse()
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Project> {
    return this.projects.get(workspace, id);
  }

  @Patch(':id')
  @RequireRole('MEMBER')
  @ApiBody({ schema: openApiSchema(updateProjectRequestSchema, 'input') })
  @ApiOkResponse({ schema: openApiSchema(projectSchema) })
  @ApiNotFoundResponse()
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProjectRequestSchema)) body: UpdateProjectRequest,
  ): Promise<Project> {
    return this.projects.update(workspace, id, body);
  }

  @Delete(':id')
  @RequireRole('ADMIN')
  @HttpCode(204)
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'A run is still active' })
  async remove(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.projects.delete(workspace, id);
  }
}
