import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { JobSource, MonitoringSchedule, PrismaClient } from '@jobfinder/database';
import {
  contentHash,
  FetchError,
  parsePage,
  registrableDomain,
  type PageFetcher,
} from '@jobfinder/enrichment';
import type {
  AiJobExtractor,
  BoardRef,
  JobFetchResult,
  JobProviderRegistry,
} from '@jobfinder/jobs';
import {
  DEFAULT_MISS_POLICY,
  nextRunAfterAnswer,
  nextRunAfterFailure,
  nextRunForRecheck,
  type MissPolicy,
  type NotificationEvent,
} from '@jobfinder/monitoring';
import { ENV, type Env } from '../config/env.token';
import { PAGE_FETCHER } from '../enrichment/enrichment.tokens';
import { PRISMA } from '../infrastructure.module';
import { persistCheck } from '../jobs/job-persister';
import { JOB_AI_EXTRACTOR, JOB_PROVIDER_REGISTRY } from '../jobs/jobs.tokens';
import { NotificationService } from './notification.service';

const CHECK_TIMEOUT_MS = 5 * 60_000;
const MINUTE_MS = 60_000;

type ScheduleWithRefs = MonitoringSchedule & {
  jobSource: JobSource | null;
  company: {
    id: string;
    workspaceId: string;
    displayName: string;
    website: string | null;
    domain: string | null;
    status: string;
  };
};

export interface RunOutcome {
  /** What the check found out; FAILED/INCONCLUSIVE say nothing about the jobs. */
  outcome: string;
  skipped?: string;
}

/**
 * Runs one scheduled check. The rules that matter:
 *  - a failed request is a PROVIDER problem: it is recorded on the check and the schedule and
 *    retried with backoff, and it never opens, closes or changes a job (persistCheck enforces
 *    that for sources; the website check does not touch jobs at all);
 *  - a missing job is only closed after confirming checks (see persistCheck), so a job that
 *    went missing is looked at again soon;
 *  - everything is idempotent: re-running a check cannot duplicate a job or a notification.
 */
@Injectable()
export class MonitoringProcessor {
  private readonly logger = new Logger(MonitoringProcessor.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
    @Inject(JOB_PROVIDER_REGISTRY) private readonly registry: JobProviderRegistry,
    @Inject(PAGE_FETCHER) private readonly fetcher: PageFetcher,
    private readonly notifications: NotificationService,
    @Optional() @Inject(JOB_AI_EXTRACTOR) private readonly ai?: AiJobExtractor | null,
  ) {}

  private get missPolicy(): MissPolicy {
    return {
      confirmations: this.env.MONITOR_MISS_CONFIRMATIONS ?? DEFAULT_MISS_POLICY.confirmations,
      minGapMinutes: this.env.MONITOR_MISS_MIN_GAP_MINUTES ?? DEFAULT_MISS_POLICY.minGapMinutes,
    };
  }

  async run(scheduleId: string): Promise<RunOutcome> {
    const schedule = await this.prisma.monitoringSchedule.findUnique({
      where: { id: scheduleId },
      include: {
        jobSource: true,
        company: {
          select: {
            id: true,
            workspaceId: true,
            displayName: true,
            website: true,
            domain: true,
            status: true,
          },
        },
      },
    });
    if (!schedule) return { outcome: 'SKIPPED', skipped: 'schedule deleted' };

    if (!schedule.enabled || !this.env.MONITOR_ENABLED || schedule.company.status !== 'ACTIVE') {
      // Paused (or the whole system is): release the claim; nextRunAt is kept so that resuming
      // checks promptly, and nothing is recorded as a failure.
      await this.release(schedule.id);
      return { outcome: 'SKIPPED', skipped: 'monitoring disabled' };
    }

    try {
      return schedule.kind === 'WEBSITE'
        ? await this.runWebsite(schedule)
        : await this.runSource(schedule);
    } catch (error) {
      // A bug or an unexpected error: record it as a failed run and back off. Never rethrow
      // into a retry storm, and never touch job state.
      const message = error instanceof Error ? error.message : 'Unexpected error';
      this.logger.error(`Schedule ${schedule.id} failed unexpectedly: ${message}`);
      await this.recordFailure(schedule, 'UNEXPECTED', message, new Date());
      return { outcome: 'FAILED' };
    }
  }

  // ---------------------------------------------------------------- job sources

  private async runSource(schedule: ScheduleWithRefs): Promise<RunOutcome> {
    const source = schedule.jobSource;
    const provider = source ? this.registry.get(source.providerId) : undefined;
    if (!source || source.status !== 'ACTIVE' || !provider) {
      await this.prisma.monitoringSchedule.update({
        where: { id: schedule.id },
        data: {
          enabled: false,
          lockedUntil: null,
          lastOutcome: 'SOURCE_INACTIVE',
          lastRunAt: new Date(),
        },
      });
      return { outcome: 'SKIPPED', skipped: 'source is not active' };
    }

    const board: BoardRef = {
      providerId: source.providerId,
      boardKey: source.boardKey,
      boardUrl: source.boardUrl,
      ...(source.region === 'eu' ? { region: 'eu' as const } : {}),
    };
    const startedAt = new Date();
    let result: JobFetchResult;
    try {
      result = await provider.fetchJobs(board, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        ai: this.ai ?? undefined,
      });
    } catch (error) {
      // Providers report source failures as results; this is a bug or a cancellation. It is
      // still only a failed CHECK: no job changes because of it.
      result = {
        outcome: 'FAILED',
        error: {
          code: 'UNEXPECTED',
          message: error instanceof Error ? error.message : 'Unexpected error',
          retryable: true,
        },
        jobs: [],
        pagesFetched: 0,
      };
    }

    const summary = await persistCheck(this.prisma, source, null, result, startedAt, {
      trigger: 'SCHEDULED',
      scheduleId: schedule.id,
      missPolicy: this.missPolicy,
      notify: async (tx, events) => {
        await this.notifications.emit(tx, schedule.workspaceId, events);
      },
    });

    const now = new Date();
    if (result.outcome === 'FAILED') {
      await this.recordFailure(schedule, result.error.code, result.error.message, now);
    } else {
      const answered = result.outcome === 'JOBS' || result.outcome === 'NO_OPENINGS';
      const planned = nextRunAfterAnswer(now, schedule.intervalMinutes);
      await this.prisma.monitoringSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: now,
          lastOutcome: result.outcome,
          lockedUntil: null,
          ...(answered ? { lastSuccessAt: now, consecutiveFailures: 0 } : {}),
          // Jobs waiting for a confirming check: look again soon instead of in 12 hours.
          nextRunAt:
            summary.pendingConfirmation > 0
              ? nextRunForRecheck(now, planned, this.env.MONITOR_RECHECK_MINUTES)
              : planned,
        },
      });
    }
    return { outcome: result.outcome };
  }

  // ---------------------------------------------------------------- website

  private async runWebsite(schedule: ScheduleWithRefs): Promise<RunOutcome> {
    const company = schedule.company;
    if (!company.website) {
      await this.prisma.monitoringSchedule.update({
        where: { id: schedule.id },
        data: {
          lockedUntil: null,
          lastRunAt: new Date(),
          lastOutcome: 'NO_WEBSITE',
          nextRunAt: nextRunAfterAnswer(new Date(), schedule.intervalMinutes),
        },
      });
      return { outcome: 'SKIPPED', skipped: 'the company has no website' };
    }

    const startedAt = new Date();
    const base = {
      workspaceId: schedule.workspaceId,
      companyId: company.id,
      scheduleId: schedule.id,
      url: company.website,
      startedAt,
    };
    try {
      const page = await this.fetcher.fetchText(company.website, {
        allowedContentTypes: ['text/html', 'application/xhtml+xml'],
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        maxBytes: 1024 * 1024,
        timeoutMs: 20_000,
        signal: AbortSignal.timeout(60_000),
      });
      const finalDomain = registrableDomain(page.url);
      const hash = contentHash(parsePage(page.body, page.url).text);

      const previous = await this.prisma.websiteCheck.findFirst({
        where: { companyId: company.id, outcome: 'OK' },
        orderBy: { id: 'desc' },
        select: { finalDomain: true, contentHash: true },
      });
      const knownDomain = previous?.finalDomain ?? company.domain;
      const changeKind =
        knownDomain && finalDomain && knownDomain !== finalDomain
          ? 'DOMAIN_CHANGED'
          : previous?.contentHash && previous.contentHash !== hash
            ? 'CONTENT_CHANGED'
            : null;

      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.websiteCheck.create({
          data: {
            ...base,
            outcome: 'OK',
            httpStatus: page.status,
            finalUrl: page.url,
            finalDomain,
            contentHash: hash,
            changeKind,
            finishedAt: now,
          },
        });
        // Only a move to another domain is news; ordinary content edits are just recorded.
        if (changeKind === 'DOMAIN_CHANGED') {
          const event: NotificationEvent = {
            type: 'WEBSITE_CHANGED',
            companyId: company.id,
            companyName: company.displayName,
            reason: 'DOMAIN_CHANGED',
            from: knownDomain ?? undefined,
            to: finalDomain ?? undefined,
          };
          await this.notifications.emit(tx, schedule.workspaceId, [event]);
        }
        await tx.monitoringSchedule.update({
          where: { id: schedule.id },
          data: {
            lastRunAt: now,
            lastSuccessAt: now,
            lastOutcome: 'OK',
            consecutiveFailures: 0,
            lockedUntil: null,
            nextRunAt: nextRunAfterAnswer(now, schedule.intervalMinutes),
          },
        });
      });
      return { outcome: changeKind ?? 'OK' };
    } catch (error) {
      const code = error instanceof FetchError ? error.code : 'UNEXPECTED';
      const message = error instanceof Error ? error.message : 'Unexpected error';
      const now = new Date();
      await this.prisma.websiteCheck.create({
        data: {
          ...base,
          outcome: 'FAILED',
          httpStatus: error instanceof FetchError ? (error.httpStatus ?? null) : null,
          errorCode: code,
          errorMessage: message.slice(0, 500),
          finishedAt: now,
        },
      });
      // A website that is down says NOTHING about its vacancies: jobs are untouched.
      const failures = await this.recordFailure(schedule, code, message, now);
      await this.announceOutage(schedule, failures);
      return { outcome: 'FAILED' };
    }
  }

  /** One "website unavailable" notice per outage, once the failures are persistent. */
  private async announceOutage(schedule: ScheduleWithRefs, failures: number): Promise<void> {
    if (failures < this.env.MONITOR_WEBSITE_FAILURES_BEFORE_ALERT) return;
    const lastOk = await this.prisma.websiteCheck.findFirst({
      where: { companyId: schedule.companyId, outcome: 'OK' },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const firstFailure = await this.prisma.websiteCheck.findFirst({
      where: {
        companyId: schedule.companyId,
        outcome: 'FAILED',
        ...(lastOk ? { id: { gt: lastOk.id } } : {}),
      },
      orderBy: { id: 'asc' },
      select: { startedAt: true },
    });
    const event: NotificationEvent = {
      type: 'WEBSITE_CHANGED',
      companyId: schedule.companyId,
      companyName: schedule.company.displayName,
      reason: 'UNAVAILABLE',
      since: firstFailure?.startedAt ?? new Date(),
      failures,
    };
    // The dedupe key is the start of the outage, so repeated failures announce it only once.
    await this.prisma.$transaction((tx) =>
      this.notifications.emit(tx, schedule.workspaceId, [event]),
    );
  }

  // ---------------------------------------------------------------- bookkeeping

  private async release(scheduleId: string): Promise<void> {
    await this.prisma.monitoringSchedule.updateMany({
      where: { id: scheduleId },
      data: { lockedUntil: null },
    });
  }

  /** Records a provider error on the schedule (not on any job) and plans a backed-off retry. */
  private async recordFailure(
    schedule: MonitoringSchedule,
    code: string,
    message: string,
    now: Date,
  ): Promise<number> {
    const failures = schedule.consecutiveFailures + 1;
    await this.prisma.monitoringSchedule.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: now,
        lastOutcome: 'FAILED',
        consecutiveFailures: failures,
        lastErrorCode: code,
        lastErrorMessage: message.slice(0, 500),
        lastErrorAt: now,
        lockedUntil: null,
        nextRunAt: nextRunAfterFailure(
          now,
          schedule.intervalMinutes,
          failures,
          this.env.MONITOR_FAILURE_BACKOFF_MINUTES,
        ),
      },
    });
    return failures;
  }

  /** Lock window for claimed schedules, exposed for the scheduler. */
  get lockMs(): number {
    return this.env.MONITOR_LOCK_MINUTES * MINUTE_MS;
  }
}
