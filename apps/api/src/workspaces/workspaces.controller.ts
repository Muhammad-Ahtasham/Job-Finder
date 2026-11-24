import { Controller, Get } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { workspaceListResponseSchema, type WorkspaceListResponse } from '@jobfinder/contracts';
import { openApiSchema } from '../common/openapi';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth } from '../auth/decorators';
import { WorkspacesService } from './workspaces.service';

@ApiTags('workspaces')
@ApiCookieAuth()
@Controller({ path: 'workspaces', version: '1' })
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  @ApiOkResponse({ schema: openApiSchema(workspaceListResponseSchema) })
  async list(@CurrentAuth() auth: AuthContext): Promise<WorkspaceListResponse> {
    return { workspaces: await this.workspaces.listForUser(auth.user.id) };
  }
}
