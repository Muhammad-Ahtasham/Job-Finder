import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { WorkspaceRole } from '@jobfinder/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { MIN_ROLE } from './workspace.decorators';
import { ROLE_RANK } from './workspace.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs after the global AuthGuard. Picks the workspace from `X-Workspace-Id` (must be a
 * workspace the caller belongs to) or falls back to the caller's personal workspace, then
 * enforces the route's minimum role. Everything downstream scopes queries by `request.workspace.id`.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.auth) throw new UnauthorizedException('Authentication required');
    const userId = request.auth.user.id;

    const header = request.headers['x-workspace-id'];
    let membership: { workspaceId: string; role: WorkspaceRole } | null;

    if (typeof header === 'string' && header.length > 0) {
      if (!UUID.test(header)) throw new BadRequestException('X-Workspace-Id must be a UUID');
      membership = await this.prisma.client.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: header, userId } },
        select: { workspaceId: true, role: true },
      });
      // 403 (not 404): the caller named a workspace they do not belong to.
      if (!membership) throw new ForbiddenException('You are not a member of this workspace');
    } else {
      membership = await this.prisma.client.workspaceMember.findFirst({
        where: { userId },
        orderBy: [{ workspace: { isPersonal: 'desc' } }, { createdAt: 'asc' }],
        select: { workspaceId: true, role: true },
      });
      if (!membership) throw new ForbiddenException('You do not belong to any workspace');
    }

    const required =
      this.reflector.getAllAndOverride<WorkspaceRole>(MIN_ROLE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'VIEWER';
    if (ROLE_RANK[membership.role] < ROLE_RANK[required]) {
      throw new ForbiddenException(`This action requires the ${required} role or higher`);
    }

    request.workspace = { id: membership.workspaceId, role: membership.role };
    return true;
  }
}
