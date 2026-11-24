import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';
import type { WorkspaceRole } from '@jobfinder/contracts';
import { WorkspaceGuard } from './workspace.guard';
import type { WorkspaceContext } from './workspace.types';

export const MIN_ROLE = 'minRole';

/** Minimum workspace role for a route (default: VIEWER, i.e. read access). */
export const RequireRole = (role: WorkspaceRole) => SetMetadata(MIN_ROLE, role);

/** Marks a controller as workspace-scoped: resolves + authorizes the workspace per request. */
export const WorkspaceScoped = () =>
  applyDecorators(
    UseGuards(WorkspaceGuard),
    ApiHeader({
      name: 'X-Workspace-Id',
      required: false,
      description: 'Workspace to act in. Defaults to your personal workspace.',
    }),
  );

export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceContext => {
    const request = ctx.switchToHttp().getRequest<Request>();
    if (!request.workspace) throw new Error('CurrentWorkspace used without WorkspaceGuard');
    return request.workspace;
  },
);
