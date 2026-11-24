import { Injectable, NotFoundException } from '@nestjs/common';
import type { CompanyDetail, CompanyListResponse } from '@jobfinder/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { toCompanySummary } from './company.mapper';

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    workspace: WorkspaceContext,
    query: { q?: string; limit: number; cursor?: string },
  ): Promise<CompanyListResponse> {
    const rows = await this.prisma.client.company.findMany({
      where: {
        workspaceId: workspace.id,
        status: 'ACTIVE',
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        ...(query.q
          ? {
              OR: [
                { displayName: { contains: query.q, mode: 'insensitive' as const } },
                { domain: { contains: query.q.toLowerCase() } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: { _count: { select: { sources: true } } },
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toCompanySummary),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }

  async get(workspace: WorkspaceContext, id: string): Promise<CompanyDetail> {
    const company = await this.prisma.client.company.findFirst({
      where: { id, workspaceId: workspace.id },
      include: {
        _count: { select: { sources: true } },
        aliases: { orderBy: { alias: 'asc' } },
        locations: { orderBy: { createdAt: 'asc' } },
        identities: { orderBy: { type: 'asc' } },
        sources: { orderBy: { retrievedAt: 'asc' } },
      },
    });
    if (!company) throw new NotFoundException('Company not found');

    return {
      ...toCompanySummary(company),
      mergedIntoId: company.mergedIntoId,
      aliases: company.aliases.map((a) => a.alias),
      locations: company.locations.map((l) => ({
        city: l.city,
        address: l.addressRaw,
        lat: l.lat,
        lng: l.lng,
        phones: l.phones,
      })),
      identities: company.identities.map((i) => ({ type: i.type, scope: i.scope, value: i.value })),
      sources: company.sources.map((s) => ({
        providerId: s.providerId,
        sourceUrl: s.sourceUrl,
        attribution: s.attribution,
        matchedKeyword: s.matchedKeyword,
        retrievedAt: s.retrievedAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
      })),
    };
  }
}
