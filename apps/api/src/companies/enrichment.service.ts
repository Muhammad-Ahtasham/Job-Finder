import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Company } from '@jobfinder/database';
import type {
  CompanyContactsResponse,
  CompanyReview,
  CompanySourcesResponse,
  EnrichResponse,
} from '@jobfinder/contracts';
import { normalizeWebsite } from '@jobfinder/discovery';
import { isUniqueViolation } from '../common/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentQueueService } from '../queue/enrichment-queue.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import {
  toCompanyContact,
  toCompanyPage,
  toCompanyReview,
  toExtractionRun,
} from './enrichment.mapper';

@Injectable()
export class EnrichmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: EnrichmentQueueService,
  ) {}

  private async activeCompany(workspace: WorkspaceContext, id: string): Promise<Company> {
    const company = await this.prisma.client.company.findFirst({
      where: { id, workspaceId: workspace.id },
    });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  /**
   * Start enriching a company. Idempotent: while a run is queued or running, further calls
   * return that same run (`reused: true`) — the database guarantees it with a unique
   * `activeKey`, so two simultaneous requests cannot start two crawls.
   */
  async enrich(
    workspace: WorkspaceContext,
    userId: string,
    companyId: string,
  ): Promise<EnrichResponse> {
    const company = await this.activeCompany(workspace, companyId);
    if (company.status !== 'ACTIVE') {
      throw new ConflictException(`Company was merged into ${company.mergedIntoId}`);
    }

    let reused = false;
    let run;
    try {
      run = await this.prisma.client.extractionRun.create({
        data: {
          workspaceId: workspace.id,
          companyId: company.id,
          requestedById: userId,
          activeKey: company.id,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      run = await this.prisma.client.extractionRun.findUnique({ where: { activeKey: company.id } });
      if (!run) throw error; // finished between the two statements: the caller may simply retry
      reused = true;
    }
    await this.queue.enqueue(run.id); // idempotent (deterministic job id)
    return { run: toExtractionRun(run), reused };
  }

  async sources(workspace: WorkspaceContext, companyId: string): Promise<CompanySourcesResponse> {
    const company = await this.activeCompany(workspace, companyId);
    const [pages, reviews, runs] = await Promise.all([
      this.prisma.client.companyPage.findMany({
        where: { companyId },
        orderBy: [{ type: 'asc' }, { url: 'asc' }],
      }),
      this.prisma.client.companyReview.findMany({
        where: { companyId, kind: 'WEBSITE' },
        orderBy: [{ confidence: 'desc' }, { updatedAt: 'desc' }],
      }),
      this.prisma.client.extractionRun.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    const current = company.domain
      ? reviews.find((r) => r.subjectKey === company.domain && r.status === 'APPROVED')
      : undefined;
    return {
      companyId,
      website: {
        url: company.website,
        status: company.websiteStatus,
        review: current ? toCompanyReview(current) : null,
      },
      careersStatus: company.careersStatus,
      emailStatus: company.emailStatus,
      pages: pages.map(toCompanyPage),
      candidates: reviews.map(toCompanyReview),
      runs: runs.map(toExtractionRun),
      lastEnrichedAt: company.lastEnrichedAt?.toISOString() ?? null,
    };
  }

  async contacts(
    workspace: WorkspaceContext,
    companyId: string,
    query: { kind?: 'EMAIL' | 'LINKEDIN'; category?: string },
  ): Promise<CompanyContactsResponse> {
    await this.activeCompany(workspace, companyId);
    const rows = await this.prisma.client.companyContact.findMany({
      where: {
        companyId,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.category ? { category: query.category as never } : {}),
      },
      orderBy: [{ kind: 'asc' }, { confidence: 'desc' }, { value: 'asc' }],
    });
    return { companyId, items: rows.map(toCompanyContact) };
  }

  async listReviews(workspace: WorkspaceContext, companyId: string): Promise<CompanyReview[]> {
    await this.activeCompany(workspace, companyId);
    const rows = await this.prisma.client.companyReview.findMany({
      where: { companyId, kind: 'WEBSITE' },
      orderBy: [{ status: 'asc' }, { confidence: 'desc' }],
    });
    return rows.map(toCompanyReview);
  }

  /** A person confirms a website candidate: it becomes the company's website and is never re-judged. */
  async approve(
    workspace: WorkspaceContext,
    userId: string,
    reviewId: string,
  ): Promise<CompanyReview> {
    const review = await this.prisma.client.companyReview.findFirst({
      where: { id: reviewId, workspaceId: workspace.id },
    });
    if (!review) throw new NotFoundException('Review not found');
    if (review.status === 'APPROVED' && review.decidedManually) return toCompanyReview(review);

    const site = normalizeWebsite(review.subjectUrl);
    if (!site) throw new ConflictException('The candidate is not a valid website');

    try {
      const updated = await this.prisma.client.$transaction(async (tx) => {
        const owner = await tx.companyIdentity.findUnique({
          where: {
            workspaceId_type_scope_value: {
              workspaceId: workspace.id,
              type: 'DOMAIN',
              scope: '',
              value: site.domain,
            },
          },
        });
        if (owner && owner.companyId !== review.companyId) {
          throw new ConflictException('This domain already belongs to another company');
        }
        // Only one website per company: an earlier automatic approval is superseded.
        await tx.companyReview.updateMany({
          where: {
            companyId: review.companyId,
            kind: 'WEBSITE',
            status: 'APPROVED',
            id: { not: review.id },
            decidedManually: false,
          },
          data: { status: 'REJECTED' },
        });
        const company = await tx.company.findUniqueOrThrow({ where: { id: review.companyId } });
        if (company.domain && company.domain !== site.domain) {
          await tx.companyIdentity.deleteMany({
            where: { companyId: company.id, type: 'DOMAIN', value: company.domain },
          });
        }
        await tx.company.update({
          where: { id: company.id },
          data: { website: site.url, domain: site.domain, websiteStatus: 'VERIFIED' },
        });
        if (!owner) {
          await tx.companyIdentity.create({
            data: {
              companyId: company.id,
              workspaceId: workspace.id,
              type: 'DOMAIN',
              scope: '',
              value: site.domain,
            },
          });
        }
        return tx.companyReview.update({
          where: { id: review.id },
          data: {
            status: 'APPROVED',
            decidedManually: true,
            resolvedById: userId,
            resolvedAt: new Date(),
          },
        });
      });
      return toCompanyReview(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This domain already belongs to another company');
      }
      throw error;
    }
  }

  /**
   * A person says the candidate is NOT the company's website. If it is the website currently
   * on record, it is removed together with everything that was harvested from it, and later
   * enrichment will never propose or crawl it again.
   */
  async reject(
    workspace: WorkspaceContext,
    userId: string,
    reviewId: string,
  ): Promise<CompanyReview> {
    const review = await this.prisma.client.companyReview.findFirst({
      where: { id: reviewId, workspaceId: workspace.id },
    });
    if (!review) throw new NotFoundException('Review not found');
    if (review.status === 'REJECTED' && review.decidedManually) return toCompanyReview(review);

    const updated = await this.prisma.client.$transaction(async (tx) => {
      const company = await tx.company.findUniqueOrThrow({ where: { id: review.companyId } });
      if (company.domain === review.subjectKey) {
        await tx.companyIdentity.deleteMany({
          where: { companyId: company.id, type: 'DOMAIN', value: review.subjectKey },
        });
        // Every page and contact came from this site: none of it belongs to the company.
        await tx.companyContact.deleteMany({ where: { companyId: company.id } });
        await tx.companyPage.deleteMany({ where: { companyId: company.id } });
        await tx.company.update({
          where: { id: company.id },
          data: {
            website: null,
            domain: null,
            websiteStatus: 'FAILED',
            emailStatus: 'MISSING',
            careersStatus: 'MISSING',
          },
        });
      }
      return tx.companyReview.update({
        where: { id: review.id },
        data: {
          status: 'REJECTED',
          decidedManually: true,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      });
    });
    return toCompanyReview(updated);
  }
}
