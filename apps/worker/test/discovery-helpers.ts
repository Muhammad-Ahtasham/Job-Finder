import { randomUUID } from 'node:crypto';
import type { PrismaClient, RunStatus, SearchRun } from '@jobfinder/database';
import type {
  CompanyCandidate,
  CompanyDiscoveryProvider,
  DiscoveryPage,
  DiscoveryProjectInput,
  DiscoveryQuery,
} from '@jobfinder/discovery';

export type Handler = (
  cursor: string | undefined,
  callNo: number,
) => Promise<DiscoveryPage> | DiscoveryPage;

/** Scriptable provider: each keyword maps to a handler that can page, fail, or block. */
export class FakeProvider implements CompanyDiscoveryProvider {
  readonly displayName: string;
  readonly terms = {
    termsUrl: 'https://example.test/terms',
    reviewedAt: '2026-01-01',
    storage: 'PERMANENT' as const,
    attribution: 'fake attribution',
    bulkAllowed: true,
  };
  readonly rateLimit = { maxRequests: 100, perMs: 1000, concurrency: 2 };
  readonly calls: { keyword?: string; cursor?: string }[] = [];
  private readonly handlers = new Map<string, Handler>();
  private readonly counts = new Map<string, number>();

  constructor(
    readonly id: string,
    readonly cityScoped: boolean,
  ) {
    this.displayName = `Fake ${id}`;
  }

  on(keyword: string, handler: Handler): void {
    this.handlers.set(keyword, handler);
  }

  planQueries(project: DiscoveryProjectInput): DiscoveryQuery[] {
    return project.keywords.map((keyword) => ({
      kind: 'KEYWORD' as const,
      key: `kw:${keyword.toLowerCase()}`,
      keyword,
      project,
    }));
  }

  async search(query: DiscoveryQuery, cursor: string | undefined): Promise<DiscoveryPage> {
    this.calls.push({ keyword: query.keyword, cursor });
    const handler = this.handlers.get(query.keyword ?? '');
    if (!handler) return { candidates: [], filtered: 0 };
    const key = `${query.keyword}|${cursor ?? ''}`;
    const callNo = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, callNo);
    return handler(cursor, callNo);
  }
}

export const page = (
  candidates: CompanyCandidate[],
  extra: Partial<DiscoveryPage> = {},
): DiscoveryPage => ({
  candidates,
  filtered: 0,
  ...extra,
});

export function candidate(
  providerId: string,
  name: string,
  extra: Partial<CompanyCandidate> = {},
): CompanyCandidate {
  return { providerId, name, nameConfidence: 'HIGH', retrievedAt: new Date(), ...extra };
}

export interface Fixture {
  workspaceId: string;
  userId: string;
  projectId: string;
  keywords: string[];
}

/** A fresh user + workspace + project so tests never share rows. */
export async function createFixture(
  prisma: PrismaClient,
  keywords: string[],
  overrides: { workspaceId?: string; userId?: string } = {},
): Promise<Fixture> {
  const user = overrides.userId
    ? { id: overrides.userId }
    : await prisma.user.create({
        data: { email: `disc-${randomUUID()}@example.test`, name: 'Disc Test', passwordHash: 'x' },
      });
  const workspaceId =
    overrides.workspaceId ??
    (
      await prisma.workspace.create({
        data: {
          name: 'WS',
          slug: `ws-${randomUUID()}`,
          members: { create: { userId: user.id, role: 'OWNER' } },
        },
      })
    ).id;
  const project = await prisma.searchProject.create({
    data: {
      workspaceId,
      createdById: user.id,
      name: `Project ${randomUUID()}`,
      country: 'PK',
      city: 'Lahore',
      industry: 'Software Development',
      keywords,
    },
  });
  return { workspaceId, userId: user.id, projectId: project.id, keywords };
}

export async function createRun(
  prisma: PrismaClient,
  fixture: Fixture,
  extra: object = {},
): Promise<SearchRun> {
  return prisma.searchRun.create({
    data: {
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      requestedById: fixture.userId,
      config: {
        country: 'PK',
        city: 'Lahore',
        industry: 'Software Development',
        keywords: fixture.keywords,
      },
      ...extra,
    },
  });
}

const TERMINAL: RunStatus[] = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'];

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  { timeoutMs = 20_000, intervalMs = 50, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const waitForTerminalRun = (prisma: PrismaClient, runId: string): Promise<SearchRun> =>
  waitFor<SearchRun>(
    async () => {
      const run = await prisma.searchRun.findUnique({ where: { id: runId } });
      return run && TERMINAL.includes(run.status) ? run : undefined;
    },
    { label: `run ${runId} to finish` },
  );

/** Mimics the API's cancel transaction. */
export async function cancelRun(prisma: PrismaClient, runId: string) {
  const now = new Date();
  await prisma.discoveryTask.updateMany({
    where: { runId, status: { in: ['QUEUED', 'RETRYING'] } },
    data: { status: 'CANCELLED', finishedAt: now },
  });
  const running = await prisma.discoveryTask.count({ where: { runId, status: 'RUNNING' } });
  await prisma.searchRun.update({
    where: { id: runId },
    data: {
      cancelRequestedAt: now,
      ...(running === 0 ? { status: 'CANCELLED', finishedAt: now } : {}),
    },
  });
}
