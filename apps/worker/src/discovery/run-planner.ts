import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@jobfinder/database';
import type { DiscoveryProjectInput } from '@jobfinder/discovery';
import { ENV, type Env } from '../config/env.token';
import { PRISMA } from '../infrastructure.module';
import { DISCOVERY_PROVIDERS } from './discovery.tokens';
import { ProviderQueuesService } from './provider-queues.service';
import { ProviderRegistry } from './provider-registry';
import type { ProviderSet } from '@jobfinder/discovery';

interface StoredConfig extends DiscoveryProjectInput {
  providers?: unknown;
}

/**
 * Expands a run into DiscoveryTasks (provider × query) and hands them to the provider
 * queues. Every step is idempotent: re-planning the same run creates no duplicate tasks
 * and just re-delivers anything still open.
 */
@Injectable()
export class RunPlanner {
  private readonly logger = new Logger(RunPlanner.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
    @Inject(DISCOVERY_PROVIDERS) private readonly providerSet: ProviderSet,
    private readonly registry: ProviderRegistry,
    private readonly queues: ProviderQueuesService,
  ) {}

  async plan(runId: string): Promise<'planned' | 'redelivered' | 'skipped'> {
    // QUEUED → RUNNING exactly once; a crashed earlier attempt leaves RUNNING + unplanned,
    // which we happily continue.
    await this.prisma.searchRun.updateMany({
      where: { id: runId, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    const run = await this.prisma.searchRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== 'RUNNING' || run.cancelRequestedAt) return 'skipped';

    if (run.plannedAt) {
      await this.deliverOpenTasks(runId);
      return 'redelivered';
    }

    const config = run.config as unknown as StoredConfig;
    const project: DiscoveryProjectInput = {
      country: config.country,
      city: config.city,
      industry: config.industry,
      keywords: config.keywords,
    };

    const specs = this.registry.providers.flatMap((provider) =>
      provider.planQueries(project).map((query) => ({ provider, query })),
    );
    const snapshot = {
      ...config,
      providers: this.registry.providers.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        attribution: p.terms.attribution ?? null,
      })),
      skippedProviders: this.providerSet.skipped,
    };

    if (specs.length === 0) {
      await this.prisma.searchRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          plannedAt: new Date(),
          finishedAt: new Date(),
          config: {
            ...snapshot,
            planError:
              'No discovery provider is available. Enable one via DISCOVERY_PROVIDERS (and satisfy its licence requirements).',
          } as unknown as Prisma.InputJsonValue,
        },
      });
      this.logger.warn(`Run ${runId} has nothing to execute: no providers/queries`);
      return 'planned';
    }

    await this.prisma.$transaction([
      this.prisma.discoveryTask.createMany({
        data: specs.map(({ provider, query }) => ({
          runId,
          providerId: provider.id,
          queryKey: query.key,
          kind: query.kind,
          keyword: query.keyword ?? null,
          maxAttempts: this.env.DISCOVERY_MAX_ATTEMPTS,
        })),
        skipDuplicates: true,
      }),
      this.prisma.searchRun.update({
        where: { id: runId },
        data: { plannedAt: new Date(), config: snapshot as unknown as Prisma.InputJsonValue },
      }),
    ]);

    await this.deliverOpenTasks(runId);
    this.logger.log(`Run ${runId} planned: ${specs.length} task(s)`);
    return 'planned';
  }

  /** Ensures every unfinished task has a live job in its provider queue. */
  async deliverOpenTasks(runId: string): Promise<void> {
    const tasks = await this.prisma.discoveryTask.findMany({
      where: { runId, status: { in: ['QUEUED', 'RETRYING'] } },
      select: { id: true, providerId: true, maxAttempts: true },
    });
    for (const task of tasks) {
      const result = await this.queues.ensureTaskJob(task.providerId, task.id, task.maxAttempts);
      if (result === 'no-provider') {
        await this.prisma.discoveryTask.updateMany({
          where: { id: task.id, status: { in: ['QUEUED', 'RETRYING'] } },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            lastErrorCode: 'PROVIDER_UNAVAILABLE',
            lastErrorMessage: `Provider "${task.providerId}" is not enabled in this worker`,
            lastErrorRetryable: false,
            lastErrorAt: new Date(),
          },
        });
      }
    }
  }
}
