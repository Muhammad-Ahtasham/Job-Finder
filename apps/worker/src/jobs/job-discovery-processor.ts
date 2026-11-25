import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Company, JobRun, JobSource, Prisma, PrismaClient } from '@jobfinder/database';
import { canonicalizeUrl, registrableDomain } from '@jobfinder/enrichment';
import {
  type AiJobExtractor,
  type AtsDetection,
  type BoardRef,
  type CareerPageCandidate,
  type CareerPageDiscoveryService,
  type JobFetchResult,
  type JobProviderRegistry,
} from '@jobfinder/jobs';
import { PRISMA } from '../infrastructure.module';
import { persistCheck } from './job-persister';
import {
  CAREER_DISCOVERY,
  JOB_AI_EXTRACTOR,
  JOB_PROVIDER_REGISTRY,
  RetryableJobError,
} from './jobs.tokens';

const TERMINAL = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED']);
const MAX_SOURCES = 8;
const MAX_RECORDED_ERRORS = 20;
const OVERALL_TIMEOUT_MS = 10 * 60_000;

interface RunError {
  code: string;
  message: string;
  retryable: boolean;
}
interface PlannedSource {
  board: BoardRef;
  supported: boolean;
  platform: string;
  fromUrl?: string;
  confidence?: number;
  evidence?: string;
}
const asJson = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * One job-discovery run for one company:
 *   1. find the company's career pages (content-verified) and the ATS behind them;
 *   2. record each place jobs are published as a JobSource (ATS boards, generic pages, and
 *      recognised-but-unsupported platforms);
 *   3. fetch every supported source and persist the result as a JobCheck + jobs.
 * Each source is committed on its own, so a failure on one never discards another, and a
 * re-run converges on the same rows.
 */
@Injectable()
export class JobDiscoveryProcessor {
  private readonly logger = new Logger(JobDiscoveryProcessor.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(JOB_PROVIDER_REGISTRY) private readonly registry: JobProviderRegistry,
    @Inject(CAREER_DISCOVERY) private readonly careers: CareerPageDiscoveryService,
    @Optional() @Inject(JOB_AI_EXTRACTOR) private readonly ai?: AiJobExtractor | null,
  ) {}

  async process(runId: string): Promise<void> {
    const run = await this.prisma.jobRun.findUnique({ where: { id: runId } });
    if (!run || TERMINAL.has(run.status)) return;

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
    await this.prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: 'RUNNING',
        startedAt: run.startedAt ?? new Date(),
        attempts: { increment: 1 },
      },
    });

    const signal = AbortSignal.timeout(OVERALL_TIMEOUT_MS);
    const errors: RunError[] = [];

    const planned = await this.plan(company, errors, signal);
    const sources = await this.recordSources(company, planned, run);

    const outcomes: JobFetchResult['outcome'][] = [];
    let retryableFailures = 0;
    let jobsFound = 0;
    const totals = { created: 0, updated: 0, closed: 0, duplicates: 0 };
    for (const source of sources) {
      if (source.status !== 'ACTIVE') continue; // unsupported platforms are recorded, never read
      const provider = this.registry.get(source.providerId);
      if (!provider) continue;
      const board: BoardRef = {
        providerId: source.providerId,
        boardKey: source.boardKey,
        boardUrl: source.boardUrl,
        ...(source.region === 'eu' ? { region: 'eu' as const } : {}),
      };
      const startedAt = new Date();
      let result: JobFetchResult;
      try {
        result = await provider.fetchJobs(board, { signal, ai: this.ai ?? undefined });
      } catch (error) {
        // Providers report source failures as results; this is a bug or a cancellation.
        result = {
          outcome: 'FAILED',
          error: {
            code: 'UNEXPECTED',
            message: error instanceof Error ? error.message : 'Unexpected error',
            retryable: false,
          },
          jobs: [],
          pagesFetched: 0,
        };
      }
      const summary = await persistCheck(this.prisma, source, run.id, result, startedAt);
      outcomes.push(result.outcome);
      jobsFound += summary.jobsFound;
      totals.created += summary.jobsCreated;
      totals.updated += summary.jobsUpdated;
      totals.closed += summary.jobsClosed;
      totals.duplicates += summary.duplicatesSkipped;
      if (result.outcome === 'FAILED') {
        errors.push({
          code: result.error.code,
          message: `${source.providerId}/${source.boardKey}: ${result.error.message}`,
          retryable: result.error.retryable,
        });
        if (result.error.retryable) retryableFailures += 1;
      } else if (result.outcome === 'INCONCLUSIVE') {
        errors.push({
          code: 'INCONCLUSIVE',
          message: `${source.boardUrl}: ${result.reason}`,
          retryable: false,
        });
      }
    }

    const active = outcomes.length;
    if (planned.length === 0 && sources.length === 0) {
      errors.push({
        code: 'NO_JOB_SOURCE_FOUND',
        message:
          'No career page or job board could be found. This does not mean the company has no vacancies.',
        retryable: false,
      });
    }

    // Nothing could be read from any source and it is worth another try: let the queue retry.
    if (active > 0 && outcomes.every((o) => o === 'FAILED') && retryableFailures === active) {
      await this.prisma.jobRun.update({
        where: { id: run.id },
        data: { errors: asJson(errors.slice(0, MAX_RECORDED_ERRORS)) },
      });
      throw new RetryableJobError('Every job source was unreachable', errors[0]!.code);
    }

    const now = new Date();
    await this.prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: errors.length > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
        activeKey: null,
        careerPagesFound: planned.length,
        sourcesChecked: active,
        jobsFound,
        stats: asJson({ ...totals, sources: sources.length }),
        errors: asJson(errors.slice(0, MAX_RECORDED_ERRORS)),
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
      },
    });
    this.logger.log(
      `Job run ${run.id}: ${sources.length} source(s), ${jobsFound} job(s), ${errors.length} error(s)`,
    );
  }

  async markFailed(runId: string, code: string, message: string): Promise<void> {
    await this.prisma.jobRun.updateMany({
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

  async markRetrying(runId: string, error: Error): Promise<void> {
    await this.prisma.jobRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: {
        status: 'QUEUED',
        errorCode: error instanceof RetryableJobError ? error.code : 'RETRYING',
        errorMessage: error.message.slice(0, 500),
      },
    });
  }

  // ------------------------------------------------------------ planning

  /** Career pages → ATS boards / generic pages to read. */
  private async plan(
    company: Company,
    errors: RunError[],
    signal: AbortSignal,
  ): Promise<PlannedSource[]> {
    const knownPages = await this.prisma.companyPage.findMany({
      where: {
        companyId: company.id,
        type: { in: ['CAREERS', 'JOBS'] },
        fetchStatus: { in: ['FETCHED', 'DISCOVERED'] },
      },
      select: { url: true },
    });
    const knownUrls = knownPages.map((p) => p.url);

    let candidates: CareerPageCandidate[];
    if (company.website && company.websiteStatus === 'VERIFIED') {
      const found = await this.careers.discover({
        homepageUrl: company.website,
        knownUrls,
        signal,
      });
      candidates = found.candidates;
      for (const e of found.errors)
        errors.push({ code: e.code, message: `${e.url}: ${e.message}`, retryable: e.retryable });
      await this.saveCareerPages(company, candidates);
    } else {
      // No verified site to crawl: still honour career pages / ATS boards enrichment already found.
      candidates = knownUrls.flatMap((url) => {
        const detection = this.careers.identifyUrl(url);
        return detection
          ? [
              {
                url,
                kind: 'ATS_HOSTED' as const,
                confidence: 0.8,
                signals: ['previously identified'],
                detections: [detection],
                fetched: false,
              },
            ]
          : [];
      });
      if (candidates.length === 0) {
        errors.push({
          code: 'NO_VERIFIED_WEBSITE',
          message: 'The company has no verified website to search for career pages',
          retryable: false,
        });
      }
    }

    const planned = new Map<string, PlannedSource>();
    const add = (p: PlannedSource) => {
      const key = `${p.board.providerId}:${p.board.region ?? ''}:${p.board.boardKey.toLowerCase()}`;
      if (!planned.has(key)) planned.set(key, p);
    };
    for (const candidate of candidates) {
      const detections: AtsDetection[] = candidate.detections;
      if (detections.length > 0) {
        for (const d of detections) {
          add({
            board: d.board ?? {
              providerId: d.platform,
              boardKey: new URL(d.url).hostname + new URL(d.url).pathname.replace(/\/$/, ''),
              boardUrl: d.url,
            },
            supported: d.supported,
            platform: d.platform,
            fromUrl: candidate.url,
            confidence: candidate.confidence,
            evidence: `${d.platform} via ${d.evidence.toLowerCase()}: ${candidate.signals.slice(0, 3).join('; ')}`,
          });
        }
      } else if (candidate.fetched) {
        const url = canonicalizeUrl(candidate.url);
        add({
          board: { providerId: 'generic-html', boardKey: url, boardUrl: url },
          supported: true,
          platform: 'generic-html',
          fromUrl: candidate.url,
          confidence: candidate.confidence,
          evidence: candidate.signals.slice(0, 4).join('; '),
        });
      }
    }
    return [...planned.values()].slice(0, MAX_SOURCES);
  }

  /** Career pages are stored with the Phase 3 pages so both views agree. */
  private async saveCareerPages(
    company: Company,
    candidates: CareerPageCandidate[],
  ): Promise<void> {
    const now = new Date();
    for (const c of candidates) {
      const url = canonicalizeUrl(c.url);
      const existing = await this.prisma.companyPage.findUnique({
        where: { companyId_url: { companyId: company.id, url } },
        select: { fetchStatus: true },
      });
      const data = {
        type: 'CAREERS' as const,
        typeConfidence: c.confidence,
        classifiedBy: 'RULES' as const,
        title: c.title ?? null,
        lastSeenAt: now,
      };
      if (existing) {
        // Only refine what a Phase 3 crawl already fetched; never downgrade it.
        await this.prisma.companyPage.update({
          where: { companyId_url: { companyId: company.id, url } },
          data: existing.fetchStatus === 'FETCHED' ? { lastSeenAt: now } : data,
        });
      } else {
        await this.prisma.companyPage.create({
          data: {
            companyId: company.id,
            workspaceId: company.workspaceId,
            url,
            ...data,
            fetchStatus: c.fetched ? 'FETCHED' : 'DISCOVERED',
            external: registrableDomain(url) !== registrableDomain(company.website ?? url),
            fetchedAt: c.fetched ? now : null,
            depth: 1,
          },
        });
      }
    }
  }

  /** Upsert JobSource rows; also carry over sources found earlier so a flaky discovery cannot stop refreshes. */
  private async recordSources(
    company: Company,
    planned: PlannedSource[],
    _run: JobRun,
  ): Promise<JobSource[]> {
    const out = new Map<string, JobSource>();
    for (const p of planned) {
      const source = await this.prisma.jobSource.upsert({
        where: {
          companyId_providerId_boardKey: {
            companyId: company.id,
            providerId: p.board.providerId,
            boardKey: p.board.boardKey,
          },
        },
        create: {
          workspaceId: company.workspaceId,
          companyId: company.id,
          providerId: p.board.providerId,
          boardKey: p.board.boardKey,
          boardUrl: p.board.boardUrl,
          region: p.board.region ?? null,
          status: p.supported ? 'ACTIVE' : 'UNSUPPORTED',
          discoveredFromUrl: p.fromUrl ?? null,
          discoveryConfidence: p.confidence ?? null,
          discoveryEvidence: p.evidence?.slice(0, 500) ?? null,
        },
        update: {
          boardUrl: p.board.boardUrl,
          discoveredFromUrl: p.fromUrl ?? null,
          discoveryConfidence: p.confidence ?? null,
          discoveryEvidence: p.evidence?.slice(0, 500) ?? null,
        },
      });
      out.set(source.id, source);
    }
    const earlier = await this.prisma.jobSource.findMany({
      where: { companyId: company.id, status: 'ACTIVE', id: { notIn: [...out.keys()] } },
      orderBy: { createdAt: 'asc' },
      take: MAX_SOURCES,
    });
    for (const s of earlier) out.set(s.id, s);
    return [...out.values()];
  }
}
