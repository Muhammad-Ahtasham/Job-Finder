import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, type Company, type ExtractionRun, type PrismaClient } from '@jobfinder/database';
import { normalizeWebsite } from '@jobfinder/discovery';
import {
  registrableDomain,
  type EnrichmentError,
  type FetchedPage,
  type SiteDiscoveryResult,
  type WebsiteCandidateFinder,
  type WebsiteEnrichmentProvider,
  type WebsiteVerificationResult,
} from '@jobfinder/enrichment';
import { PRISMA } from '../infrastructure.module';
import {
  ENRICHMENT_PROVIDER,
  RetryableEnrichmentError,
  WEBSITE_CANDIDATE_FINDER,
} from './enrichment.tokens';

const TERMINAL = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED']);
const MAX_CANDIDATES = 4;
const MAX_RECORDED_ERRORS = 20;
const OVERALL_TIMEOUT_MS = 5 * 60_000;

interface Accepted {
  url: string;
  homepage?: FetchedPage;
  manual: boolean;
}

type Json = Prisma.InputJsonValue;
const asJson = (value: unknown) => value as Json;

/**
 * Enriches one company. PostgreSQL is the source of truth and every write is an upsert on a
 * natural key, so re-running the same enrichment (job redelivery, a second POST, a retry)
 * converges on the same rows instead of duplicating them.
 *
 * Order of events:
 *   1. choose + verify candidate websites (company.website first, then an optional finder),
 *      recording every decision and its evidence as a CompanyReview;
 *   2. only for a verified site: crawl, classify pages, extract published contacts;
 *   3. persist pages, contacts, company statuses and the run result in ONE transaction.
 */
@Injectable()
export class EnrichmentProcessor {
  private readonly logger = new Logger(EnrichmentProcessor.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENRICHMENT_PROVIDER) private readonly provider: WebsiteEnrichmentProvider,
    @Optional()
    @Inject(WEBSITE_CANDIDATE_FINDER)
    private readonly finder?: WebsiteCandidateFinder,
  ) {}

  /** Throws RetryableEnrichmentError when nothing could be decided because sites were unreachable. */
  async process(runId: string): Promise<void> {
    const run = await this.prisma.extractionRun.findUnique({ where: { id: runId } });
    if (!run || TERMINAL.has(run.status)) return; // redelivered job for a finished run

    const company = await this.prisma.company.findFirst({
      where: { id: run.companyId, workspaceId: run.workspaceId },
    });
    if (!company || company.status !== 'ACTIVE') {
      await this.markFailed(
        run.id,
        'COMPANY_UNAVAILABLE',
        'Company no longer exists or was merged',
      );
      return;
    }

    await this.prisma.extractionRun.update({
      where: { id: run.id },
      data: {
        status: 'RUNNING',
        startedAt: run.startedAt ?? new Date(),
        attempts: { increment: 1 },
      },
    });

    const signal = AbortSignal.timeout(OVERALL_TIMEOUT_MS);
    const errors: EnrichmentError[] = [];

    const evaluation = await this.chooseWebsite(run, company, errors, signal);
    if (!evaluation.accepted && evaluation.results.length === 0 && errors.length === 0) {
      errors.push({
        code: 'NO_WEBSITE_CANDIDATE',
        message: 'The company has no known website and no website search is configured',
        retryable: false,
      });
    }
    if (
      !evaluation.accepted &&
      evaluation.results.length > 0 &&
      evaluation.results.every((r) => r.error?.retryable)
    ) {
      await this.recordErrors(run.id, errors);
      throw new RetryableEnrichmentError(
        'Every candidate website was unreachable',
        evaluation.results[0]!.error!.code,
      );
    }

    let crawl: SiteDiscoveryResult | undefined;
    if (evaluation.accepted) {
      try {
        crawl = await this.provider.discoverSite(
          {
            companyName: company.displayName,
            siteUrl: evaluation.accepted.url,
            siteVerified: true,
            homepage: evaluation.accepted.homepage,
          },
          { signal },
        );
        errors.push(...crawl.errors);
      } catch (error) {
        errors.push({
          code: 'CRAWL_FAILED',
          message: error instanceof Error ? error.message : 'Crawl failed',
          retryable: true,
        });
      }
    }

    await this.commit(run, company, evaluation, crawl, errors);
  }

  /** Called when BullMQ has given up on a job. */
  async markFailed(runId: string, code: string, message: string): Promise<void> {
    await this.prisma.extractionRun.updateMany({
      where: { id: runId, status: { notIn: ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] } },
      data: {
        status: 'FAILED',
        activeKey: null,
        errorCode: code,
        errorMessage: message.slice(0, 500),
        finishedAt: new Date(),
      },
    });
  }

  /** Back to QUEUED between BullMQ retries so progress is honest. Keeps the active lock. */
  async markRetrying(runId: string, error: Error): Promise<void> {
    await this.prisma.extractionRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: {
        status: 'QUEUED',
        errorCode: error instanceof RetryableEnrichmentError ? error.code : 'RETRYING',
        errorMessage: error.message.slice(0, 500),
      },
    });
  }

  // ------------------------------------------------------------ website choice

  private async chooseWebsite(
    run: ExtractionRun,
    company: Company,
    errors: EnrichmentError[],
    signal: AbortSignal,
  ): Promise<{
    accepted?: Accepted;
    results: WebsiteVerificationResult[];
  }> {
    const reviews = await this.prisma.companyReview.findMany({
      where: { companyId: company.id, kind: 'WEBSITE' },
    });
    const byDomain = new Map(reviews.map((r) => [r.subjectKey, r]));

    // A person approved a site: trust that, skip re-verification, just crawl it.
    const approved = reviews.find((r) => r.status === 'APPROVED' && r.decidedManually);
    if (approved) return { accepted: { url: approved.subjectUrl, manual: true }, results: [] };

    const results: WebsiteVerificationResult[] = [];
    const tried = new Set<string>();

    const attempt = async (candidate: string): Promise<Accepted | undefined> => {
      const domain = registrableDomain(candidate) ?? candidate;
      if (tried.has(domain) || tried.size >= MAX_CANDIDATES) return undefined;
      tried.add(domain);
      const prior = byDomain.get(domain);
      if (prior?.decidedManually && prior.status === 'REJECTED') return undefined; // a person said no

      const result = await this.provider.verifyWebsite(
        { companyName: company.displayName, city: company.city, candidateWebsite: candidate },
        { signal },
      );
      results.push(result);
      if (result.error) errors.push(result.error);
      await this.saveReview(run, company, result, prior);
      if (result.decision === 'OFFICIAL') {
        return {
          url: result.finalUrl ?? result.candidateUrl,
          homepage: result.homepage,
          manual: false,
        };
      }
      return undefined;
    };

    if (company.website) {
      const accepted = await attempt(company.website);
      if (accepted) return { accepted, results };
    }
    // Ask the optional finder only when the company's own website did not pan out.
    if (this.finder) {
      try {
        const found = await this.finder.findCandidates(
          { companyName: company.displayName, city: company.city, country: company.country },
          { signal },
        );
        for (const candidate of found) {
          const accepted = await attempt(candidate);
          if (accepted) return { accepted, results };
        }
      } catch (error) {
        errors.push({
          code: 'CANDIDATE_SEARCH_FAILED',
          message: error instanceof Error ? error.message : 'Website search failed',
          retryable: true,
        });
      }
    }
    return { results };
  }

  private async saveReview(
    run: ExtractionRun,
    company: Company,
    result: WebsiteVerificationResult,
    prior: { decision: string; decidedManually: boolean } | undefined,
  ): Promise<void> {
    if (prior?.decidedManually) return; // a human decision is final
    // An unreachable site tells us nothing new: never overwrite a real decision with it.
    if (result.error && prior && prior.decision !== 'UNCERTAIN') return;

    const subjectKey =
      result.domain ?? registrableDomain(result.candidateUrl) ?? result.candidateUrl;
    const status =
      result.decision === 'OFFICIAL'
        ? 'APPROVED'
        : result.decision === 'REJECTED'
          ? 'REJECTED'
          : 'PENDING';
    const data = {
      subjectUrl: result.finalUrl ?? result.candidateUrl,
      decision: result.decision,
      confidence: result.confidence,
      evidence: asJson(result.evidence),
      status,
      runId: run.id,
    } as const;
    await this.prisma.companyReview.upsert({
      where: { companyId_kind_subjectKey: { companyId: company.id, kind: 'WEBSITE', subjectKey } },
      create: {
        workspaceId: company.workspaceId,
        companyId: company.id,
        kind: 'WEBSITE',
        subjectKey,
        ...data,
      },
      update: data,
    });
  }

  // ------------------------------------------------------------ persistence

  private async commit(
    run: ExtractionRun,
    company: Company,
    evaluation: { accepted?: Accepted; results: WebsiteVerificationResult[] },
    crawl: SiteDiscoveryResult | undefined,
    errors: EnrichmentError[],
  ): Promise<void> {
    const now = new Date();
    const hadProblems =
      errors.length > 0 ||
      (crawl !== undefined &&
        (crawl.stats.failed > 0 ||
          crawl.stats.blockedByRobots > 0 ||
          crawl.stats.blockedUnsafe > 0));

    await this.prisma.$transaction(async (tx) => {
      const companyData: Prisma.CompanyUpdateInput = {};
      const rejected = new Set(
        evaluation.results.filter((r) => r.decision === 'REJECTED').map((r) => r.domain ?? ''),
      );
      const uncertain = evaluation.results.some((r) => r.decision === 'UNCERTAIN');

      // ---- website
      if (evaluation.accepted) {
        const site = normalizeWebsite(evaluation.accepted.url);
        if (site) {
          companyData.website = site.url;
          companyData.domain = site.domain;
          companyData.websiteStatus = 'VERIFIED';
          if (site.domain !== company.domain) await this.claimDomain(tx, company, site.domain);
        }
      } else if (evaluation.results.length > 0) {
        let keeps = company.website !== null;
        if (company.domain && rejected.has(company.domain)) {
          // The rejected candidate was the company's recorded website: it is not its website.
          companyData.website = null;
          companyData.domain = null;
          await tx.companyIdentity.deleteMany({
            where: { companyId: company.id, type: 'DOMAIN', value: company.domain },
          });
          keeps = false;
        }
        if (keeps) {
          if (uncertain) companyData.websiteStatus = 'UNVERIFIED';
        } else {
          companyData.websiteStatus = rejected.size > 0 ? 'FAILED' : company.websiteStatus;
        }
      }

      // ---- pages and contacts
      let pagesFound = 0;
      let contactsFound = 0;
      if (crawl) {
        const pageIds = new Map<string, string>();
        for (const page of crawl.pages) {
          const data = {
            type: page.type,
            typeConfidence: page.typeConfidence,
            classifiedBy: page.classifiedBy,
            title: page.title ?? null,
            fetchStatus: page.fetchStatus,
            httpStatus: page.httpStatus ?? null,
            contentType: page.contentType ?? null,
            contentHash: page.contentHash ?? null,
            errorCode: page.errorCode ?? null,
            discoveredFrom: page.discoveredFrom ?? null,
            depth: page.depth,
            external: page.external,
            fetchedAt: page.fetchedAt ?? null,
            lastSeenAt: now,
            lastRunId: run.id,
          };
          const row = await tx.companyPage.upsert({
            where: { companyId_url: { companyId: company.id, url: page.url } },
            create: {
              companyId: company.id,
              workspaceId: company.workspaceId,
              url: page.url,
              ...data,
            },
            // A fetched page is never downgraded to "discovered/failed" by a later partial crawl.
            update: await this.pageUpdate(tx, company.id, page.url, data),
          });
          pageIds.set(page.url, row.id);
        }
        pagesFound = crawl.pages.length;

        for (const contact of crawl.contacts) {
          const data = {
            category: contact.category ?? null,
            classifiedBy: contact.classifiedBy,
            confidence: contact.confidence,
            verificationStatus: contact.verificationStatus,
            verificationMethod: contact.verificationMethod,
            extractionMethod: contact.extractionMethod,
            sourceUrl: contact.sourceUrl,
            sourcePageId: pageIds.get(contact.sourceUrl) ?? null,
            context: contact.context ?? null,
            domainMatch: contact.domainMatch ?? null,
            lastSeenAt: now,
            lastRunId: run.id,
          };
          await tx.companyContact.upsert({
            where: {
              companyId_kind_value: {
                companyId: company.id,
                kind: contact.kind,
                value: contact.value,
              },
            },
            create: {
              companyId: company.id,
              workspaceId: company.workspaceId,
              kind: contact.kind,
              value: contact.value,
              extractedAt: contact.extractedAt, // first extraction; later runs only move lastSeenAt
              ...data,
            },
            update: data,
          });
        }
        contactsFound = crawl.contacts.length;

        // ---- derived company statuses
        const emails = await tx.companyContact.findMany({
          where: { companyId: company.id, kind: 'EMAIL' },
          select: { verificationStatus: true },
        });
        // "Nothing found" is only trustworthy when the crawl was not obstructed.
        const complete = !hadProblems;
        companyData.emailStatus = emails.some((e) => e.verificationStatus === 'VERIFIED')
          ? 'VERIFIED'
          : emails.length > 0
            ? 'UNVERIFIED'
            : complete
              ? 'MISSING'
              : company.emailStatus;

        const careers = crawl.pages.filter((p) => p.type === 'CAREERS' || p.type === 'JOBS');
        companyData.careersStatus = careers.some((p) => p.fetchStatus === 'FETCHED')
          ? 'VERIFIED'
          : careers.some((p) => p.fetchStatus === 'DISCOVERED')
            ? 'UNVERIFIED' // linked from the official site, board itself not checked
            : complete
              ? 'MISSING'
              : company.careersStatus;
      }

      if (evaluation.accepted || evaluation.results.length > 0) companyData.lastEnrichedAt = now;
      if (Object.keys(companyData).length > 0) {
        await tx.company.update({ where: { id: company.id }, data: companyData });
      }

      await tx.extractionRun.update({
        where: { id: run.id },
        data: {
          status: hadProblems ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
          activeKey: null,
          websiteUrl: evaluation.accepted
            ? (normalizeWebsite(evaluation.accepted.url)?.url ?? null)
            : null,
          pagesFound,
          contactsFound,
          stats: asJson(crawl?.stats ?? {}),
          errors: asJson(errors.slice(0, MAX_RECORDED_ERRORS)),
          errorCode: null,
          errorMessage: null,
          finishedAt: now,
        },
      });
    });

    this.logger.log(
      `Enrichment ${run.id} for company ${company.id}: ${
        evaluation.accepted ? 'website verified' : 'no verified website'
      }, ${crawl?.pages.length ?? 0} pages, ${crawl?.contacts.length ?? 0} contacts, ${errors.length} error(s)`,
    );
  }

  private async pageUpdate(
    tx: Prisma.TransactionClient,
    companyId: string,
    url: string,
    data: Prisma.CompanyPageUncheckedUpdateInput,
  ): Promise<Prisma.CompanyPageUncheckedUpdateInput> {
    if (data.fetchStatus === 'FETCHED') return data;
    const existing = await tx.companyPage.findUnique({
      where: { companyId_url: { companyId, url } },
      select: { fetchStatus: true },
    });
    // Keep the last good fetch's details; only record that this run saw the URL again.
    return existing?.fetchStatus === 'FETCHED'
      ? { lastSeenAt: data.lastSeenAt, lastRunId: data.lastRunId }
      : data;
  }

  /**
   * Record the domain as this company's identity, unless another company in the workspace
   * already owns it (then both stay as they are and Phase 2's review flow applies).
   */
  private async claimDomain(tx: Prisma.TransactionClient, company: Company, domain: string) {
    const existing = await tx.companyIdentity.findUnique({
      where: {
        workspaceId_type_scope_value: {
          workspaceId: company.workspaceId,
          type: 'DOMAIN',
          scope: '',
          value: domain,
        },
      },
    });
    if (existing) return;
    await tx.companyIdentity.create({
      data: {
        companyId: company.id,
        workspaceId: company.workspaceId,
        type: 'DOMAIN',
        scope: '',
        value: domain,
      },
    });
  }

  private async recordErrors(runId: string, errors: EnrichmentError[]): Promise<void> {
    await this.prisma.extractionRun.update({
      where: { id: runId },
      data: { errors: asJson(errors.slice(0, MAX_RECORDED_ERRORS)) },
    });
  }
}
