import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { MatchReview as ReviewRow, Company } from '@jobfinder/database';
import type { CompanyDetail, MatchReview, ReviewListResponse } from '@jobfinder/contracts';
import { foldText, pairKeyOf } from '@jobfinder/discovery';
import { PrismaService } from '../prisma/prisma.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { CompaniesService } from './companies.service';
import { toCompanySummary } from './company.mapper';

type ReviewWithCompanies = ReviewRow & {
  candidate: Company & { _count: { sources: number } };
  existing: Company & { _count: { sources: number } };
};

const companyInclude = { include: { _count: { select: { sources: true } } } } as const;

/**
 * Ambiguous deduplication matches. The discovery worker never merges an uncertain match: it
 * keeps the candidate as its own company and raises a MatchReview. A human resolves it here:
 * "merge" folds the candidate into the existing company; "dismiss" records that they are
 * different companies (the pair is never raised again).
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
  ) {}

  async list(
    workspace: WorkspaceContext,
    query: { status: ReviewRow['status']; limit: number; cursor?: string },
  ): Promise<ReviewListResponse> {
    const rows = await this.prisma.client.matchReview.findMany({
      where: {
        workspaceId: workspace.id,
        status: query.status,
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: { candidate: companyInclude, existing: companyInclude },
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => this.toReview(row)),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }

  async dismiss(workspace: WorkspaceContext, userId: string, id: string): Promise<MatchReview> {
    const updated = await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ws:${workspace.id}`}, 0))`;
      const review = await tx.matchReview.findFirst({ where: { id, workspaceId: workspace.id } });
      if (!review) throw new NotFoundException('Review not found');
      if (review.status !== 'PENDING')
        throw new ConflictException(`Review already ${review.status}`);
      return tx.matchReview.update({
        where: { id },
        data: { status: 'DISMISSED', resolvedById: userId, resolvedAt: new Date() },
        include: { candidate: companyInclude, existing: companyInclude },
      });
    });
    return this.toReview(updated);
  }

  async merge(workspace: WorkspaceContext, userId: string, id: string): Promise<CompanyDetail> {
    const survivorId = await this.prisma.client.$transaction(async (tx) => {
      // Same lock the discovery worker takes while persisting: merges and discovery serialize.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ws:${workspace.id}`}, 0))`;

      const review = await tx.matchReview.findFirst({ where: { id, workspaceId: workspace.id } });
      if (!review) throw new NotFoundException('Review not found');
      if (review.status !== 'PENDING')
        throw new ConflictException(`Review already ${review.status}`);

      const [survivor, loser] = await Promise.all([
        tx.company.findFirst({
          where: { id: review.existingCompanyId, workspaceId: workspace.id },
        }),
        tx.company.findFirst({
          where: { id: review.candidateCompanyId, workspaceId: workspace.id },
        }),
      ]);
      if (!survivor || !loser) throw new NotFoundException('Company not found');
      if (survivor.status !== 'ACTIVE' || loser.status !== 'ACTIVE') {
        throw new ConflictException('One of the companies has already been merged');
      }

      // --- provenance and results move over wholesale
      await tx.companySource.updateMany({
        where: { companyId: loser.id },
        data: { companyId: survivor.id },
      });
      await tx.discoveryResult.updateMany({
        where: { companyId: loser.id },
        data: { companyId: survivor.id },
      });

      // --- children with per-company uniqueness: move or drop duplicates
      const [survivorLocs, loserLocs] = await Promise.all([
        tx.companyLocation.findMany({
          where: { companyId: survivor.id },
          select: { locationKey: true },
        }),
        tx.companyLocation.findMany({ where: { companyId: loser.id } }),
      ]);
      const locKeys = new Set(survivorLocs.map((l) => l.locationKey));
      for (const loc of loserLocs) {
        if (locKeys.has(loc.locationKey))
          await tx.companyLocation.delete({ where: { id: loc.id } });
        else
          await tx.companyLocation.update({
            where: { id: loc.id },
            data: { companyId: survivor.id },
          });
      }

      const [survivorAliases, loserAliases] = await Promise.all([
        tx.companyAlias.findMany({ where: { companyId: survivor.id }, select: { aliasKey: true } }),
        tx.companyAlias.findMany({ where: { companyId: loser.id } }),
      ]);
      const aliasKeys = new Set(survivorAliases.map((a) => a.aliasKey));
      aliasKeys.add(foldText(survivor.displayName));
      for (const alias of loserAliases) {
        if (aliasKeys.has(alias.aliasKey))
          await tx.companyAlias.delete({ where: { id: alias.id } });
        else {
          aliasKeys.add(alias.aliasKey);
          await tx.companyAlias.update({
            where: { id: alias.id },
            data: { companyId: survivor.id },
          });
        }
      }
      const loserNameKey = foldText(loser.displayName);
      if (loserNameKey && !aliasKeys.has(loserNameKey)) {
        await tx.companyAlias.create({
          data: { companyId: survivor.id, alias: loser.displayName, aliasKey: loserNameKey },
        });
      }

      const [survivorIds, loserIds] = await Promise.all([
        tx.companyIdentity.findMany({ where: { companyId: survivor.id } }),
        tx.companyIdentity.findMany({ where: { companyId: loser.id } }),
      ]);
      const idKeys = new Set(survivorIds.map((i) => `${i.type}|${i.scope}|${i.value}`));
      for (const identity of loserIds) {
        if (idKeys.has(`${identity.type}|${identity.scope}|${identity.value}`)) {
          await tx.companyIdentity.delete({ where: { id: identity.id } });
        } else {
          await tx.companyIdentity.update({
            where: { id: identity.id },
            data: { companyId: survivor.id },
          });
        }
      }

      // --- website enrichment data (Phase 3): move what the survivor lacks, drop duplicates
      const [survivorContacts, loserContacts] = await Promise.all([
        tx.companyContact.findMany({
          where: { companyId: survivor.id },
          select: { kind: true, value: true },
        }),
        tx.companyContact.findMany({ where: { companyId: loser.id } }),
      ]);
      const contactKeys = new Set(survivorContacts.map((c) => `${c.kind}|${c.value}`));
      for (const contact of loserContacts) {
        if (contactKeys.has(`${contact.kind}|${contact.value}`))
          await tx.companyContact.delete({ where: { id: contact.id } });
        else
          await tx.companyContact.update({
            where: { id: contact.id },
            data: { companyId: survivor.id },
          });
      }
      const [survivorPages, loserPages] = await Promise.all([
        tx.companyPage.findMany({ where: { companyId: survivor.id }, select: { url: true } }),
        tx.companyPage.findMany({ where: { companyId: loser.id } }),
      ]);
      const pageUrls = new Set(survivorPages.map((p) => p.url));
      for (const page of loserPages) {
        if (pageUrls.has(page.url)) await tx.companyPage.delete({ where: { id: page.id } });
        else
          await tx.companyPage.update({ where: { id: page.id }, data: { companyId: survivor.id } });
      }
      const [survivorReviews, loserReviews] = await Promise.all([
        tx.companyReview.findMany({
          where: { companyId: survivor.id },
          select: { kind: true, subjectKey: true },
        }),
        tx.companyReview.findMany({ where: { companyId: loser.id } }),
      ]);
      const reviewKeys = new Set(survivorReviews.map((r) => `${r.kind}|${r.subjectKey}`));
      for (const companyReview of loserReviews) {
        if (reviewKeys.has(`${companyReview.kind}|${companyReview.subjectKey}`))
          await tx.companyReview.delete({ where: { id: companyReview.id } });
        else
          await tx.companyReview.update({
            where: { id: companyReview.id },
            data: { companyId: survivor.id },
          });
      }

      // --- job sources (Phase 4): move what the survivor lacks; a duplicate source is dropped
      //     together with its jobs (the survivor's own copy of that board is kept)
      const [survivorSources, loserSources] = await Promise.all([
        tx.jobSource.findMany({
          where: { companyId: survivor.id },
          select: { providerId: true, boardKey: true },
        }),
        tx.jobSource.findMany({ where: { companyId: loser.id } }),
      ]);
      const sourceKeys = new Set(survivorSources.map((x) => `${x.providerId}|${x.boardKey}`));
      for (const jobSource of loserSources) {
        if (sourceKeys.has(`${jobSource.providerId}|${jobSource.boardKey}`)) {
          await tx.jobSource.delete({ where: { id: jobSource.id } });
        } else {
          await tx.jobSource.update({
            where: { id: jobSource.id },
            data: { companyId: survivor.id },
          });
          await tx.job.updateMany({
            where: { sourceId: jobSource.id },
            data: { companyId: survivor.id },
          });
          await tx.jobCheck.updateMany({
            where: { sourceId: jobSource.id },
            data: { companyId: survivor.id },
          });
        }
      }

      // --- the survivor keeps its own values; gaps are filled from the merged company
      await tx.company.update({
        where: { id: survivor.id },
        data: {
          ...(!survivor.website && loser.website
            ? {
                website: loser.website,
                domain: loser.domain,
                websiteStatus: loser.websiteStatus,
                emailStatus: loser.emailStatus,
                careersStatus: loser.careersStatus,
                lastEnrichedAt: loser.lastEnrichedAt,
              }
            : {}),
          ...(!survivor.description && loser.description ? { description: loser.description } : {}),
          ...(!survivor.city && loser.city ? { city: loser.city } : {}),
        },
      });
      await tx.company.update({
        where: { id: loser.id },
        data: { status: 'MERGED', mergedIntoId: survivor.id },
      });

      const now = new Date();
      await tx.matchReview.update({
        where: { id: review.id },
        data: { status: 'MERGED', resolvedById: userId, resolvedAt: now },
      });

      // --- other pending reviews that mentioned the merged company now point at the survivor
      const others = await tx.matchReview.findMany({
        where: {
          workspaceId: workspace.id,
          status: 'PENDING',
          id: { not: review.id },
          OR: [{ candidateCompanyId: loser.id }, { existingCompanyId: loser.id }],
        },
      });
      for (const other of others) {
        const candidateId =
          other.candidateCompanyId === loser.id ? survivor.id : other.candidateCompanyId;
        const existingId =
          other.existingCompanyId === loser.id ? survivor.id : other.existingCompanyId;
        if (candidateId === existingId) {
          await tx.matchReview.update({
            where: { id: other.id },
            data: { status: 'MERGED', resolvedById: userId, resolvedAt: now },
          });
          continue;
        }
        const pairKey = pairKeyOf(candidateId, existingId);
        const clash = await tx.matchReview.findUnique({
          where: { workspaceId_pairKey: { workspaceId: workspace.id, pairKey } },
        });
        if (clash) await tx.matchReview.delete({ where: { id: other.id } });
        else {
          await tx.matchReview.update({
            where: { id: other.id },
            data: { candidateCompanyId: candidateId, existingCompanyId: existingId, pairKey },
          });
        }
      }
      return survivor.id;
    });

    return this.companies.get(workspace, survivorId);
  }

  private toReview(row: ReviewWithCompanies): MatchReview {
    return {
      id: row.id,
      status: row.status,
      score: row.score,
      reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
      candidate: toCompanySummary(row.candidate),
      existing: toCompanySummary(row.existing),
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    };
  }
}
