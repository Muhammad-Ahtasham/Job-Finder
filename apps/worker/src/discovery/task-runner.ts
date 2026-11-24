import { Inject, Injectable, Logger } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import type {
  DiscoveryTask,
  Prisma,
  PrismaClient,
  SearchRun,
  TaskStatus,
} from '@jobfinder/database';
import { executeTaskJobSchema, type ExecuteTaskJob } from '@jobfinder/contracts';
import { ProviderError, type DiscoveryQuery } from '@jobfinder/discovery';
import { PRISMA } from '../infrastructure.module';
import { CandidatePersister, type PersistContext } from './candidate-persister';
import { ProviderRegistry } from './provider-registry';
import { RunFinalizer } from './run-finalizer';

const TERMINAL_TASK: TaskStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const TERMINAL_RUN = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'];
/** Rate-limit waits don't consume BullMQ attempts, so they get their own hard ceiling. */
const MAX_RATE_LIMIT_EXTRA = 5;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 30_000;

type RunConfig = { country: string; city: string; industry: string; keywords: string[] };

interface ErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
}

function describeError(error: unknown): ErrorInfo {
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      message: error.message.slice(0, 500),
      retryable: error.retryable,
      httpStatus: error.httpStatus,
      retryAfterMs: error.retryAfterMs,
    };
  }
  // Anything else (database blip, bug) is retried a bounded number of times, then failed.
  return {
    code: 'UNKNOWN',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    retryable: true,
  };
}

/** Executes one provider task: pages through the provider, persisting as it goes. */
@Injectable()
export class DiscoveryTaskRunner {
  private readonly logger = new Logger(DiscoveryTaskRunner.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: ProviderRegistry,
    private readonly persister: CandidatePersister,
    private readonly finalizer: RunFinalizer,
  ) {}

  async run(job: Job<ExecuteTaskJob>, worker: Worker): Promise<string> {
    const { taskId } = executeTaskJobSchema.parse(job.data);
    const task = await this.prisma.discoveryTask.findUnique({
      where: { id: taskId },
      include: { run: true },
    });
    if (!task) return 'missing';
    if (TERMINAL_TASK.includes(task.status)) return 'already-finished';

    const run = task.run;
    if (run.cancelRequestedAt || TERMINAL_RUN.includes(run.status)) {
      await this.cancelTask(task);
      return 'cancelled';
    }

    const provider = this.registry.get(task.providerId);
    if (!provider) {
      await this.failTask(
        task,
        {
          code: 'PROVIDER_UNAVAILABLE',
          message: `Provider "${task.providerId}" is not enabled in this worker`,
          retryable: false,
        },
        null,
      );
      return 'failed';
    }

    // Claim. BullMQ guarantees one active job per id, so re-claiming RUNNING (stalled
    // recovery) is safe. A concurrent cancel flips QUEUED/RETRYING → CANCELLED first.
    const claimed = await this.prisma.discoveryTask.updateMany({
      where: { id: taskId, status: { in: ['QUEUED', 'RETRYING', 'RUNNING'] } },
      data: {
        status: 'RUNNING',
        attempts: { increment: 1 },
        startedAt: task.startedAt ?? new Date(),
      },
    });
    if (claimed.count === 0) return 'lost-claim';
    const attemptNo = task.attempts + 1;
    const attempt = await this.prisma.discoveryTaskAttempt.create({
      data: { taskId, attemptNo, outcome: 'RETRYABLE_ERROR' },
    });

    const config = run.config as unknown as RunConfig;
    const query: DiscoveryQuery = {
      kind: task.kind as DiscoveryQuery['kind'],
      key: task.queryKey,
      keyword: task.keyword ?? undefined,
      project: {
        country: config.country,
        city: config.city,
        industry: config.industry,
        keywords: config.keywords,
      },
    };
    const context: PersistContext = {
      workspaceId: run.workspaceId,
      runId: run.id,
      taskId,
      providerId: provider.id,
      terms: provider.terms,
      cityScoped: provider.cityScoped,
      country: config.country,
      city: config.city,
      keyword: task.keyword ?? undefined,
    };

    try {
      let cursor = task.cursor ?? undefined;
      for (;;) {
        if (await this.isCancelled(run.id)) {
          await this.cancelRunningTask(taskId, attempt.id);
          await this.finalizer.finalizeIfDone(run.id);
          return 'cancelled';
        }

        const page = await provider.search(query, cursor);
        const totals = await this.persister.persistPage(context, page.candidates);

        // Cursor + counters advance together, after the page is durably persisted.
        await this.prisma.$transaction([
          this.prisma.discoveryTask.update({
            where: { id: taskId },
            data: {
              cursor: page.nextCursor ?? null,
              pagesFetched: { increment: 1 },
              candidatesFound: { increment: totals.newResults },
            },
          }),
          this.prisma.searchRun.update({
            where: { id: run.id },
            data: { candidatesFiltered: { increment: page.filtered } },
          }),
        ]);

        cursor = page.nextCursor;
        if (!cursor) break;
      }

      await this.prisma.$transaction([
        this.prisma.discoveryTask.update({
          where: { id: taskId },
          data: {
            status: 'SUCCEEDED',
            finishedAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null,
            lastErrorRetryable: null,
            lastErrorAt: null,
          },
        }),
        this.prisma.discoveryTaskAttempt.update({
          where: { id: attempt.id },
          data: { outcome: 'SUCCESS', finishedAt: new Date() },
        }),
      ]);
      await this.finalizer.finalizeIfDone(run.id);
      return 'succeeded';
    } catch (error) {
      return this.handleFailure(job, worker, task, run, attempt.id, attemptNo, error);
    }
  }

  private async handleFailure(
    job: Job<ExecuteTaskJob>,
    worker: Worker,
    task: DiscoveryTask,
    run: SearchRun,
    attemptId: string,
    attemptNo: number,
    error: unknown,
  ): Promise<string> {
    const info = describeError(error);
    this.logger.warn(
      `Task ${task.id} (${task.providerId}/${task.keyword ?? task.kind}) attempt ${attemptNo} failed: ${info.code} ${info.message}`,
    );

    const maxAttempts = job.opts.attempts ?? task.maxAttempts;
    const lastTry = job.attemptsMade + 1 >= maxAttempts;
    const rateLimited = info.code === 'RATE_LIMITED';

    // Rate limits pause the whole provider queue (no attempt consumed) but are bounded.
    if (rateLimited && attemptNo <= task.maxAttempts + MAX_RATE_LIMIT_EXTRA) {
      await this.recordRetry(task.id, attemptId, info);
      await worker.rateLimit(info.retryAfterMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS);
      throw Worker.RateLimitError();
    }

    if (info.retryable && !lastTry && !rateLimited) {
      await this.recordRetry(task.id, attemptId, info);
      throw error instanceof Error ? error : new Error(info.message); // BullMQ applies backoff
    }

    await this.failTask(task, info, attemptId);
    await this.finalizer.finalizeIfDone(run.id);
    return 'failed';
  }

  private async recordRetry(taskId: string, attemptId: string, info: ErrorInfo): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.discoveryTask.update({
        where: { id: taskId },
        data: {
          status: 'RETRYING',
          lastErrorCode: info.code,
          lastErrorMessage: info.message,
          lastErrorRetryable: true,
          lastErrorAt: new Date(),
        },
      }),
      this.prisma.discoveryTaskAttempt.update({
        where: { id: attemptId },
        data: {
          outcome: 'RETRYABLE_ERROR',
          errorCode: info.code,
          errorMessage: info.message,
          httpStatus: info.httpStatus,
          retryAfterMs: info.retryAfterMs,
          finishedAt: new Date(),
        },
      }),
    ]);
  }

  private async failTask(
    task: DiscoveryTask,
    info: ErrorInfo,
    attemptId: string | null,
  ): Promise<void> {
    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.discoveryTask.update({
        where: { id: task.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          lastErrorCode: info.code,
          lastErrorMessage: info.message,
          lastErrorRetryable: false,
          lastErrorAt: new Date(),
        },
      }),
    ];
    if (attemptId) {
      ops.push(
        this.prisma.discoveryTaskAttempt.update({
          where: { id: attemptId },
          data: {
            outcome: 'FATAL_ERROR',
            errorCode: info.code,
            errorMessage: info.message,
            httpStatus: info.httpStatus,
            finishedAt: new Date(),
          },
        }),
      );
    }
    await this.prisma.$transaction(ops);
    if (!attemptId) await this.finalizer.finalizeIfDone(task.runId);
  }

  private async isCancelled(runId: string): Promise<boolean> {
    const run = await this.prisma.searchRun.findUnique({
      where: { id: runId },
      select: { cancelRequestedAt: true, status: true },
    });
    return !run || run.cancelRequestedAt !== null || TERMINAL_RUN.includes(run.status);
  }

  private async cancelTask(task: DiscoveryTask): Promise<void> {
    await this.prisma.discoveryTask.updateMany({
      where: { id: task.id, status: { notIn: TERMINAL_TASK } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    await this.finalizer.finalizeIfDone(task.runId);
  }

  private async cancelRunningTask(taskId: string, attemptId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.discoveryTask.update({
        where: { id: taskId },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      }),
      this.prisma.discoveryTaskAttempt.update({
        where: { id: attemptId },
        data: { outcome: 'CANCELLED', finishedAt: new Date() },
      }),
    ]);
  }
}
