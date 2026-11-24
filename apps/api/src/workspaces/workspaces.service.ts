import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@jobfinder/database';
import type { WorkspaceMembership } from '@jobfinder/contracts';
import { PrismaService } from '../prisma/prisma.service';

export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'workspace';
}

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates the user's personal workspace and their OWNER membership. Takes the caller's
   * transaction client so registration is all-or-nothing.
   */
  async createPersonalWorkspace(
    tx: Prisma.TransactionClient,
    user: { id: string; name: string },
  ): Promise<void> {
    const workspace = await tx.workspace.create({
      data: {
        name: `${user.name}'s workspace`,
        slug: `${slugify(user.name)}-${randomBytes(4).toString('hex')}`,
        isPersonal: true,
        personalOwnerId: user.id,
      },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' },
    });
  }

  async listForUser(userId: string): Promise<WorkspaceMembership[]> {
    const memberships = await this.prisma.client.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: [{ workspace: { isPersonal: 'desc' } }, { createdAt: 'asc' }],
    });
    return memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      isPersonal: m.workspace.isPersonal,
      role: m.role,
    }));
  }
}
