import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import type { PrismaClient } from '@jobfinder/database';
import { ProviderError } from '@jobfinder/discovery';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CandidatePersister } from '../src/discovery/candidate-persister';
import { DiscoveryModule } from '../src/discovery/discovery.module';
import { DISCOVERY_PROVIDERS } from '../src/discovery/discovery.tokens';
import { DiscoveryReconciler } from '../src/discovery/reconciler';
import { RunQueueService } from '../src/discovery/run-queue.service';
import { InfrastructureModule, PRISMA } from '../src/infrastructure.module';
import {
  cancelRun,
  candidate,
  createFixture,
  createRun,
  FakeProvider,
  page,
  waitFor,
  waitForTerminalRun,
} from './discovery-helpers';

const search = new FakeProvider('fake-search', false); // web-like: no city guarantee
const osm = new FakeProvider('fake-osm', true); // area-bounded: city is trusted

let moduleRef: TestingModule;
let prisma: PrismaClient;
let runQueue: RunQueueService;
let redis: Redis;

const uid = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.flushdb();
  moduleRef = await Test.createTestingModule({ imports: [InfrastructureModule, DiscoveryModule] })
    .overrideProvider(DISCOVERY_PROVIDERS)
    .useValue({ providers: [search, osm], skipped: [] })
    .compile();
  await moduleRef.init();
  prisma = moduleRef.get<PrismaClient>(PRISMA);
  runQueue = moduleRef.get(RunQueueService);
});

afterAll(async () => {
  await moduleRef.close();
  redis.disconnect();
});

/** Create fixture + run and let the real queues execute it. */
async function execute(keywords: string[], opts: { workspaceId?: string; userId?: string } = {}) {
  const fixture = await createFixture(prisma, keywords, opts);
  const run = await createRun(prisma, fixture);
  await runQueue.ensurePlanJob(run.id);
  return { fixture, run };
}

describe('end-to-end discovery with two providers', () => {
  it('searches several keywords, dedupes across providers, keeps incomplete companies and provenance', async () => {
    const [kwA, kwB] = [`alpha-${uid()}`, `beta-${uid()}`];
    search.on(kwA, () =>
      page([
        candidate('fake-search', 'Arbisoft', { websiteUrl: 'https://arbisoft.com/' }),
        candidate('fake-search', 'Folio3', { websiteUrl: 'https://folio3.com' }),
        candidate('fake-search', 'NameOnly Co'), // no website, no phone, no address, no description
      ]),
    );
    search.on(kwB, () =>
      page(
        [
          // same hit as above reached through another keyword → recorded once
          candidate('fake-search', 'Arbisoft Pvt Ltd', {
            websiteUrl: 'https://www.arbisoft.com/about',
          }),
          candidate('fake-search', 'Systems Limited', { websiteUrl: 'https://systemsltd.com' }),
        ],
        { filtered: 3 },
      ),
    );
    osm.on(kwA, () =>
      page([
        candidate('fake-osm', 'Arbisoft', {
          externalId: 'node/1',
          websiteUrl: 'https://arbisoft.com',
        }),
        candidate('fake-osm', 'Bare Minimum Soft', { externalId: 'node/2' }),
      ]),
    );

    const { fixture, run } = await execute([kwA, kwB]);
    const done = await waitForTerminalRun(prisma, run.id);
    expect(done.status).toBe('COMPLETED');

    // 2 providers × 2 keywords
    const tasks = await prisma.discoveryTask.findMany({ where: { runId: run.id } });
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t) => t.status === 'SUCCEEDED')).toBe(true);

    const companies = await prisma.company.findMany({
      where: { workspaceId: fixture.workspaceId },
      include: { sources: true, identities: true },
    });
    expect(companies.map((c) => c.displayName).sort()).toEqual(
      ['Arbisoft', 'Bare Minimum Soft', 'Folio3', 'NameOnly Co', 'Systems Limited'].sort(),
    );

    // Cross-provider match: one Arbisoft company carrying both providers' provenance.
    const arbisoft = companies.find((c) => c.domain === 'arbisoft.com')!;
    expect(arbisoft.sources.map((s) => s.providerId).sort()).toEqual(['fake-osm', 'fake-search']);
    expect(arbisoft.sources.every((s) => s.attribution === 'fake attribution')).toBe(true);
    expect(arbisoft.identities.map((i) => `${i.type}:${i.scope}:${i.value}`).sort()).toEqual([
      'DOMAIN::arbisoft.com',
      'PROVIDER_ID:fake-osm:node/1',
    ]);

    // Incomplete companies are retained and flagged, not dropped.
    const nameOnly = companies.find((c) => c.displayName === 'NameOnly Co')!;
    expect(nameOnly).toMatchObject({
      website: null,
      websiteStatus: 'MISSING',
      emailStatus: 'MISSING',
      careersStatus: 'MISSING',
    });
    expect(companies.find((c) => c.displayName === 'Folio3')!.websiteStatus).toBe('UNVERIFIED');

    // Persisted statistics agree with the rows they describe.
    const results = await prisma.discoveryResult.findMany({ where: { runId: run.id } });
    expect(done.candidatesFound).toBe(results.length);
    expect(done.companiesCreated).toBe(5);
    expect(done.companiesMatched).toBe(1);
    expect(done.duplicatesSkipped).toBe(1); // Arbisoft via the second keyword
    expect(done.candidatesFiltered).toBe(3);
    expect(done.reviewsCreated).toBe(0);
    expect(results.filter((r) => r.outcome === 'CREATED')).toHaveLength(5);
    const arbisoftKeywordResult = results.find(
      (r) => r.providerId === 'fake-search' && r.sourceKey === 'web:arbisoft.com',
    )!;
    expect(arbisoftKeywordResult.keywords.sort()).toEqual([kwA, kwB].sort());

    // The run snapshots which providers were used (for attribution in the API).
    const config = done.config as { providers: { id: string; attribution: string }[] };
    expect(config.providers.map((p) => p.id).sort()).toEqual(['fake-osm', 'fake-search']);
  });

  it('never merges an ambiguous match: keeps both companies and raises a review', async () => {
    const kw = `review-${uid()}`;
    search.on(kw, () => page([candidate('fake-search', 'Netsol')])); // city unknown
    osm.on(kw, () => page([candidate('fake-osm', 'Netsol', { externalId: `node/${uid()}` })])); // Lahore

    const { fixture, run } = await execute([kw]);
    const done = await waitForTerminalRun(prisma, run.id);
    expect(done.status).toBe('COMPLETED');

    const companies = await prisma.company.findMany({
      where: { workspaceId: fixture.workspaceId },
    });
    expect(companies).toHaveLength(2);
    expect(companies.every((c) => c.status === 'ACTIVE')).toBe(true);

    const reviews = await prisma.matchReview.findMany({
      where: { workspaceId: fixture.workspaceId },
    });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: 'PENDING', runId: run.id });
    expect(done.reviewsCreated).toBe(1);
    expect(done.companiesCreated).toBe(2);

    const outcomes = (await prisma.discoveryResult.findMany({ where: { runId: run.id } }))
      .map((r) => r.outcome)
      .sort();
    expect(outcomes).toEqual(['CREATED', 'REVIEW_REQUIRED']);
  });

  it('keeps tenants apart: the same company in two workspaces is two companies', async () => {
    const kw = `iso-${uid()}`;
    osm.on(kw, () =>
      page([
        candidate('fake-osm', 'Shared Corp', {
          externalId: 'node/77',
          websiteUrl: 'https://shared-corp.pk',
        }),
      ]),
    );

    const a = await execute([kw]);
    const b = await execute([kw]);
    await Promise.all([waitForTerminalRun(prisma, a.run.id), waitForTerminalRun(prisma, b.run.id)]);

    const ofA = await prisma.company.findMany({
      where: { workspaceId: a.fixture.workspaceId },
      include: { sources: true },
    });
    const ofB = await prisma.company.findMany({
      where: { workspaceId: b.fixture.workspaceId },
      include: { sources: true },
    });
    expect(ofA).toHaveLength(1);
    expect(ofB).toHaveLength(1);
    expect(ofA[0]!.id).not.toBe(ofB[0]!.id);
    expect(ofA[0]!.sources.every((s) => s.workspaceId === a.fixture.workspaceId)).toBe(true);
    expect(ofB[0]!.sources.every((s) => s.workspaceId === b.fixture.workspaceId)).toBe(true);
    // …and neither run is flagged as a duplicate of the other.
    expect(
      (await prisma.searchRun.findUniqueOrThrow({ where: { id: b.run.id } })).companiesMatched,
    ).toBe(0);
  });

  it('matches a company already found in an earlier run instead of duplicating it', async () => {
    const kw = `again-${uid()}`;
    osm.on(kw, () =>
      page([
        candidate('fake-osm', 'Repeat Co', {
          externalId: 'node/55',
          websiteUrl: 'https://repeat.pk',
        }),
      ]),
    );

    const first = await execute([kw]);
    await waitForTerminalRun(prisma, first.run.id);
    const second = await createRun(prisma, first.fixture);
    await runQueue.ensurePlanJob(second.id);
    const done = await waitForTerminalRun(prisma, second.id);

    expect(await prisma.company.count({ where: { workspaceId: first.fixture.workspaceId } })).toBe(
      1,
    );
    expect(done).toMatchObject({ companiesCreated: 0, companiesMatched: 1 });
    const source = await prisma.companySource.findFirstOrThrow({
      where: { workspaceId: first.fixture.workspaceId },
    });
    expect(source.sightings).toBe(2);
  });
});

describe('idempotency', () => {
  it('replaying a persisted page writes nothing new', async () => {
    const fixture = await createFixture(prisma, ['x']);
    const run = await createRun(prisma, fixture);
    const task = await prisma.discoveryTask.create({
      data: {
        runId: run.id,
        providerId: 'fake-osm',
        queryKey: 'kw:x',
        kind: 'KEYWORD',
        keyword: 'x',
      },
    });
    const persister = moduleRef.get(CandidatePersister);
    const context = {
      workspaceId: fixture.workspaceId,
      runId: run.id,
      taskId: task.id,
      providerId: 'fake-osm',
      terms: osm.terms,
      cityScoped: true,
      country: 'PK',
      city: 'Lahore',
      keyword: 'x',
    };
    const batch = [
      candidate('fake-osm', 'One Co', { externalId: 'node/1', websiteUrl: 'https://one.pk' }),
      candidate('fake-osm', 'Two Co', { externalId: 'node/2' }),
      candidate('fake-osm', '   '), // rejected, not stored
    ];

    const first = await persister.persistPage(context, batch);
    expect(first).toMatchObject({ created: 2, duplicates: 0, rejected: 1, newResults: 2 });
    const counts = async () => ({
      companies: await prisma.company.count({ where: { workspaceId: fixture.workspaceId } }),
      sources: await prisma.companySource.count({ where: { workspaceId: fixture.workspaceId } }),
      results: await prisma.discoveryResult.count({ where: { runId: run.id } }),
      identities: await prisma.companyIdentity.count({
        where: { workspaceId: fixture.workspaceId },
      }),
    });
    const before = await counts();

    const replay = await persister.persistPage(context, batch);
    expect(replay).toMatchObject({ created: 0, duplicates: 2, newResults: 0 });
    expect(await counts()).toEqual(before);
  });

  it('concurrent tasks cannot create duplicate companies for the same hit', async () => {
    const kws = [`c1-${uid()}`, `c2-${uid()}`, `c3-${uid()}`, `c4-${uid()}`];
    for (const kw of kws) {
      search.on(kw, () =>
        page([candidate('fake-search', 'Racy Soft', { websiteUrl: 'https://racy-soft.pk' })]),
      );
      osm.on(kw, () =>
        page([
          candidate('fake-osm', 'Racy Soft', {
            externalId: 'node/racy',
            websiteUrl: 'https://racy-soft.pk',
          }),
        ]),
      );
    }
    const { fixture, run } = await execute(kws);
    await waitForTerminalRun(prisma, run.id);
    expect(await prisma.company.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1);
    expect(
      await prisma.companyIdentity.count({
        where: { workspaceId: fixture.workspaceId, type: 'DOMAIN' },
      }),
    ).toBe(1);
  });

  it('re-planning a run creates no duplicate tasks', async () => {
    const kw = `plan-${uid()}`;
    const { run } = await execute([kw]);
    await waitForTerminalRun(prisma, run.id);
    const before = await prisma.discoveryTask.count({ where: { runId: run.id } });
    await runQueue.ensurePlanJob(run.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.discoveryTask.count({ where: { runId: run.id } })).toBe(before);
  });
});

describe('reliability', () => {
  it('retries transient failures with backoff, then succeeds (attempts are tracked)', async () => {
    const kw = `retry-${uid()}`;
    osm.on(kw, (_cursor, callNo) => {
      if (callNo <= 2)
        throw new ProviderError('upstream down', 'UNAVAILABLE', {
          retryable: true,
          httpStatus: 503,
        });
      return page([candidate('fake-osm', 'Resilient Co', { externalId: 'node/9' })]);
    });
    const { fixture, run } = await execute([kw]);
    const done = await waitForTerminalRun(prisma, run.id);

    expect(done.status).toBe('COMPLETED');
    const task = await prisma.discoveryTask.findFirstOrThrow({
      where: { runId: run.id, providerId: 'fake-osm' },
      include: { attemptLog: { orderBy: { attemptNo: 'asc' } } },
    });
    expect(task).toMatchObject({ status: 'SUCCEEDED', attempts: 3, lastErrorCode: null });
    expect(task.attemptLog.map((a) => a.outcome)).toEqual([
      'RETRYABLE_ERROR',
      'RETRYABLE_ERROR',
      'SUCCESS',
    ]);
    expect(task.attemptLog[0]).toMatchObject({ errorCode: 'UNAVAILABLE', httpStatus: 503 });
    // the retried work produced exactly one company
    expect(await prisma.company.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1);
  });

  it('does not retry fatal errors and tracks them; the run completes with errors', async () => {
    const kw = `fatal-${uid()}`;
    osm.on(kw, () => {
      throw new ProviderError('bad key', 'AUTH', { retryable: false, httpStatus: 401 });
    });
    search.on(kw, () =>
      page([candidate('fake-search', 'Survivor Co', { websiteUrl: 'https://survivor.pk' })]),
    );
    const { fixture, run } = await execute([kw]);
    const done = await waitForTerminalRun(prisma, run.id);

    expect(done.status).toBe('COMPLETED_WITH_ERRORS');
    const failed = await prisma.discoveryTask.findFirstOrThrow({
      where: { runId: run.id, providerId: 'fake-osm' },
      include: { attemptLog: true },
    });
    expect(failed).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastErrorCode: 'AUTH',
      lastErrorRetryable: false,
    });
    expect(failed.attemptLog.map((a) => a.outcome)).toEqual(['FATAL_ERROR']);
    expect(await prisma.company.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1);
  });

  it('gives up after the maximum attempts and fails the run when nothing succeeded', async () => {
    const kw = `exhaust-${uid()}`;
    const down = () => {
      throw new ProviderError('still down', 'UNAVAILABLE', { retryable: true });
    };
    osm.on(kw, down);
    search.on(kw, down);
    const { run } = await execute([kw]);
    const done = await waitForTerminalRun(prisma, run.id);

    expect(done.status).toBe('FAILED');
    const tasks = await prisma.discoveryTask.findMany({ where: { runId: run.id } });
    expect(tasks.every((t) => t.status === 'FAILED' && t.attempts === 3)).toBe(true); // DISCOVERY_MAX_ATTEMPTS=3
  });

  it('resumes from the persisted cursor instead of refetching earlier pages', async () => {
    const kw = `cursor-${uid()}`;
    osm.on(kw, (cursor, callNo) => {
      if (!cursor)
        return page([candidate('fake-osm', 'Page One Co', { externalId: 'node/p1' })], {
          nextCursor: 'p2',
        });
      if (callNo === 1) throw new ProviderError('blip', 'TIMEOUT', { retryable: true });
      return page([candidate('fake-osm', 'Page Two Co', { externalId: 'node/p2' })]);
    });
    const before = osm.calls.length;
    const { fixture, run } = await execute([kw]);
    const done = await waitForTerminalRun(prisma, run.id);

    expect(done.status).toBe('COMPLETED');
    const mine = osm.calls
      .slice(before)
      .filter((c) => c.keyword === kw)
      .map((c) => c.cursor);
    expect(mine).toEqual([undefined, 'p2', 'p2']); // page one fetched once
    expect(await prisma.company.count({ where: { workspaceId: fixture.workspaceId } })).toBe(2);
    expect(
      await prisma.discoveryTask.findFirstOrThrow({
        where: { runId: run.id, providerId: 'fake-osm' },
      }),
    ).toMatchObject({
      pagesFetched: 2,
      cursor: null,
    });
  });

  it('pauses on provider rate limiting without consuming retry attempts', async () => {
    const kw = `rate-${uid()}`;
    osm.on(kw, (_c, callNo) => {
      if (callNo === 1)
        throw new ProviderError('slow down', 'RATE_LIMITED', {
          retryable: true,
          retryAfterMs: 150,
          httpStatus: 429,
        });
      return page([candidate('fake-osm', 'Patient Co', { externalId: 'node/rl' })]);
    });
    const { run } = await execute([kw]);
    const done = await waitForTerminalRun(prisma, run.id);
    expect(done.status).toBe('COMPLETED');
    const task = await prisma.discoveryTask.findFirstOrThrow({
      where: { runId: run.id, providerId: 'fake-osm' },
      include: { attemptLog: { orderBy: { attemptNo: 'asc' } } },
    });
    expect(task.status).toBe('SUCCEEDED');
    expect(task.attemptLog[0]).toMatchObject({
      outcome: 'RETRYABLE_ERROR',
      errorCode: 'RATE_LIMITED',
      retryAfterMs: 150,
    });
  });

  it('cancels at a page boundary, keeping partial results', async () => {
    const kw = `cancel-${uid()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    osm.on(kw, async (cursor) => {
      if (!cursor)
        return page([candidate('fake-osm', 'Kept One', { externalId: 'node/k1' })], {
          nextCursor: 'p2',
        });
      if (cursor === 'p2') {
        await gate;
        return page([candidate('fake-osm', 'Kept Two', { externalId: 'node/k2' })], {
          nextCursor: 'p3',
        });
      }
      throw new Error('page 3 must never be requested after cancellation');
    });
    const before = osm.calls.length;
    const { fixture, run } = await execute([kw]);

    await waitFor(
      async () => osm.calls.slice(before).some((c) => c.keyword === kw && c.cursor === 'p2'),
      {
        label: 'page 2 to be in flight',
      },
    );
    await cancelRun(prisma, run.id);
    release();

    const done = await waitForTerminalRun(prisma, run.id);
    expect(done.status).toBe('CANCELLED');
    expect(done.cancelRequestedAt).not.toBeNull();
    const task = await prisma.discoveryTask.findFirstOrThrow({
      where: { runId: run.id, providerId: 'fake-osm' },
    });
    expect(task.status).toBe('CANCELLED');
    expect(osm.calls.slice(before).some((c) => c.cursor === 'p3')).toBe(false);
    expect(
      (await prisma.company.findMany({ where: { workspaceId: fixture.workspaceId } }))
        .map((c) => c.displayName)
        .sort(),
    ).toEqual(['Kept One', 'Kept Two']);
  });

  it('does not plan a run that was cancelled before it started', async () => {
    const fixture = await createFixture(prisma, ['never']);
    const run = await createRun(prisma, fixture, {
      status: 'CANCELLED',
      cancelRequestedAt: new Date(),
      finishedAt: new Date(),
    });
    await runQueue.ensurePlanJob(run.id);
    await new Promise((r) => setTimeout(r, 400));
    expect(await prisma.discoveryTask.count({ where: { runId: run.id } })).toBe(0);
    expect((await prisma.searchRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      'CANCELLED',
    );
  });
});

describe('reconciliation (PostgreSQL is the source of truth)', () => {
  it('plans a run whose plan job was never enqueued', async () => {
    const kw = `lost-plan-${uid()}`;
    osm.on(kw, () => page([candidate('fake-osm', 'Recovered Co', { externalId: 'node/rec' })]));
    const fixture = await createFixture(prisma, [kw]);
    const run = await createRun(prisma, fixture);
    await prisma.$executeRaw`UPDATE search_runs SET created_at = now() - interval '10 minutes' WHERE id = ${run.id}::uuid`;

    const summary = await moduleRef.get(DiscoveryReconciler).reconcile();
    expect(summary.plansRequeued).toBeGreaterThanOrEqual(1);
    const done = await waitForTerminalRun(prisma, run.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.companiesCreated).toBe(1);
  });

  it('re-delivers a task whose queue job disappeared', async () => {
    const kw = `lost-task-${uid()}`;
    osm.on(kw, () => page([candidate('fake-osm', 'Rescued Co', { externalId: 'node/res' })]));
    const fixture = await createFixture(prisma, [kw]);
    const run = await createRun(prisma, fixture, {
      status: 'RUNNING',
      startedAt: new Date(),
      plannedAt: new Date(),
    });
    const task = await prisma.discoveryTask.create({
      data: {
        runId: run.id,
        providerId: 'fake-osm',
        queryKey: `kw:${kw}`,
        kind: 'KEYWORD',
        keyword: kw,
      },
    });
    await prisma.$executeRaw`UPDATE discovery_tasks SET updated_at = now() - interval '10 minutes' WHERE id = ${task.id}::uuid`;

    const summary = await moduleRef.get(DiscoveryReconciler).reconcile();
    expect(summary.tasksRequeued).toBeGreaterThanOrEqual(1);
    const done = await waitForTerminalRun(prisma, run.id);
    expect(done.status).toBe('COMPLETED');
    expect(await prisma.company.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1);
  });

  it('purges raw provider data once its storage window has expired', async () => {
    const fixture = await createFixture(prisma, ['purge']);
    const company = await prisma.company.create({
      data: {
        workspaceId: fixture.workspaceId,
        displayName: 'P',
        nameKey: 'p',
        coreName: 'p',
        nameTokens: ['p'],
        coreTokens: ['p'],
        country: 'PK',
      },
    });
    const expired = await prisma.companySource.create({
      data: {
        companyId: company.id,
        workspaceId: fixture.workspaceId,
        providerId: 'x',
        sourceKey: 'a',
        rawName: 'P',
        rawData: { secret: 1 },
        retrievedAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const live = await prisma.companySource.create({
      data: {
        companyId: company.id,
        workspaceId: fixture.workspaceId,
        providerId: 'x',
        sourceKey: 'b',
        rawName: 'P',
        rawData: { keep: 1 },
        retrievedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await moduleRef.get(DiscoveryReconciler).purgeExpiredSourceData();
    expect(
      (await prisma.companySource.findUniqueOrThrow({ where: { id: expired.id } })).rawData,
    ).toBeNull();
    expect(
      (await prisma.companySource.findUniqueOrThrow({ where: { id: live.id } })).rawData,
    ).toEqual({ keep: 1 });
  });
});
