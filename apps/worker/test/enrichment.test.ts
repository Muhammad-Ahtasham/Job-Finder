import { Test, type TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import type { PrismaClient } from '@jobfinder/database';
import { CrawlerWebsiteEnrichmentProvider, FetchError } from '@jobfinder/enrichment';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnrichmentModule } from '../src/enrichment/enrichment.module';
import { EnrichmentProcessor } from '../src/enrichment/enrichment-processor';
import { EnrichmentQueueService } from '../src/enrichment/enrichment-queue.service';
import {
  ENRICHMENT_PROVIDER,
  RetryableEnrichmentError,
  WEBSITE_CANDIDATE_FINDER,
} from '../src/enrichment/enrichment.tokens';
import { RedisDomainRateLimiter } from '../src/enrichment/redis-rate-limiter';
import { InfrastructureModule, PRISMA } from '../src/infrastructure.module';
import {
  acmeSite,
  bakerySite,
  createCompany,
  createRun,
  createWorkspace,
  FakeInternet,
  waitForTerminalRun,
} from './enrichment-helpers';

let moduleRef: TestingModule;
let redis: Redis;
let prisma: PrismaClient;
let processor: EnrichmentProcessor;
let queue: EnrichmentQueueService;
const internet = new FakeInternet();
const finder = {
  id: 'fake-finder',
  calls: 0,
  results: [] as string[],
  findCandidates: async () => [] as string[],
};
finder.findCandidates = async () => {
  finder.calls += 1;
  return finder.results;
};
let useFinder = false;

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.flushdb();
  moduleRef = await Test.createTestingModule({ imports: [InfrastructureModule, EnrichmentModule] })
    .overrideProvider(ENRICHMENT_PROVIDER)
    .useValue(new CrawlerWebsiteEnrichmentProvider({ fetcher: internet }))
    .overrideProvider(WEBSITE_CANDIDATE_FINDER)
    .useValue(null)
    .compile();
  await moduleRef.init();
  prisma = moduleRef.get<PrismaClient>(PRISMA);
  processor = moduleRef.get(EnrichmentProcessor);
  queue = moduleRef.get(EnrichmentQueueService);
  // Swap the optional finder in without rebuilding the module.
  (processor as unknown as { finder?: unknown }).finder = undefined;
});

afterAll(async () => {
  await moduleRef.close();
  redis.disconnect();
});

beforeEach(() => {
  internet.requested.length = 0;
  internet.failures.clear();
  for (const key of Object.keys(internet.sites)) delete internet.sites[key];
  finder.calls = 0;
  finder.results = [];
  (processor as unknown as { finder?: unknown }).finder = useFinder ? finder : undefined;
});

async function enrich(fixture: { workspaceId: string; userId: string }, companyId: string) {
  const run = await createRun(prisma, fixture, companyId);
  await processor.process(run.id);
  return prisma.extractionRun.findUniqueOrThrow({ where: { id: run.id } });
}

describe('enriching a company with a good website', () => {
  it('verifies the site with evidence and stores pages and sourced contacts', async () => {
    internet.add(acmeSite());
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://acme-tech.com/',
      domain: 'acme-tech.com',
      websiteStatus: 'UNVERIFIED',
    });

    const run = await enrich(fx, company.id);
    expect(run).toMatchObject({
      status: 'COMPLETED',
      activeKey: null,
      websiteUrl: 'https://acme-tech.com/',
      pagesFound: 4,
      errorCode: null,
    });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.contactsFound).toBe(5); // 4 e-mails + LinkedIn

    const after = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after).toMatchObject({
      websiteStatus: 'VERIFIED',
      emailStatus: 'VERIFIED',
      careersStatus: 'VERIFIED',
    });
    expect(after.lastEnrichedAt).toBeInstanceOf(Date);

    const review = await prisma.companyReview.findUniqueOrThrow({
      where: {
        companyId_kind_subjectKey: {
          companyId: company.id,
          kind: 'WEBSITE',
          subjectKey: 'acme-tech.com',
        },
      },
    });
    expect(review).toMatchObject({
      decision: 'OFFICIAL',
      status: 'APPROVED',
      decidedManually: false,
    });
    expect((review.evidence as { signal: string }[]).map((e) => e.signal)).toContain(
      'NAME_ON_PAGE',
    );

    const pages = await prisma.companyPage.findMany({ where: { companyId: company.id } });
    const byType = Object.fromEntries(pages.map((p) => [p.type, p]));
    expect(Object.keys(byType).sort()).toEqual(['ABOUT', 'CAREERS', 'CONTACT', 'HOMEPAGE']);
    expect(byType.CAREERS).toMatchObject({
      url: 'https://acme-tech.com/careers',
      fetchStatus: 'FETCHED',
      httpStatus: 200,
    });
    expect(byType.CAREERS!.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const contacts = await prisma.companyContact.findMany({ where: { companyId: company.id } });
    const email = (v: string) => contacts.find((c) => c.value === v)!;
    expect(
      contacts
        .filter((c) => c.kind === 'EMAIL')
        .map((c) => c.value)
        .sort(),
    ).toEqual([
      'careers@acme-tech.com',
      'hello@acme-tech.com',
      'hr@acme-tech.com',
      'info@acme-tech.com',
    ]);
    expect(email('careers@acme-tech.com')).toMatchObject({
      category: 'CAREERS',
      verificationStatus: 'VERIFIED',
      verificationMethod: 'PUBLISHED_ON_VERIFIED_SITE',
      sourceUrl: 'https://acme-tech.com/careers',
      sourcePageId: byType.CAREERS!.id,
    });
    expect(email('hr@acme-tech.com')).toMatchObject({
      category: 'HR',
      extractionMethod: 'OBFUSCATED',
    });
    for (const contact of contacts) {
      expect(contact.sourceUrl).toBeTruthy(); // every contact has a source
      expect(contact.extractedAt).toBeInstanceOf(Date);
      expect(contact.confidence).toBeGreaterThan(0);
    }
    expect(contacts.find((c) => c.kind === 'LINKEDIN')?.value).toBe(
      'https://www.linkedin.com/company/acme-tech',
    );
  });

  it('is idempotent: enriching again changes timestamps, not rows', async () => {
    internet.add(acmeSite());
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://acme-tech.com/',
    });

    await enrich(fx, company.id);
    const snapshot = async () => ({
      pages: await prisma.companyPage.findMany({
        where: { companyId: company.id },
        orderBy: { url: 'asc' },
      }),
      contacts: await prisma.companyContact.findMany({
        where: { companyId: company.id },
        orderBy: { value: 'asc' },
      }),
      reviews: await prisma.companyReview.count({ where: { companyId: company.id } }),
      identities: await prisma.companyIdentity.count({ where: { companyId: company.id } }),
    });
    const first = await snapshot();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await enrich(fx, company.id);
    const second = await snapshot();

    expect(second.reviews).toBe(first.reviews);
    expect(second.identities).toBe(first.identities);
    expect(second.pages.map((p) => [p.id, p.url, p.type, p.contentHash])).toEqual(
      first.pages.map((p) => [p.id, p.url, p.type, p.contentHash]),
    );
    expect(
      second.contacts.map((c) => [c.id, c.value, c.category, c.sourceUrl, c.verificationStatus]),
    ).toEqual(
      first.contacts.map((c) => [c.id, c.value, c.category, c.sourceUrl, c.verificationStatus]),
    );
    // first extraction time is kept; last-seen moves
    expect(second.contacts.map((c) => c.extractedAt.getTime())).toEqual(
      first.contacts.map((c) => c.extractedAt.getTime()),
    );
    expect(second.contacts[0]!.lastSeenAt.getTime()).toBeGreaterThan(
      first.contacts[0]!.lastSeenAt.getTime(),
    );
    expect(await prisma.extractionRun.count({ where: { companyId: company.id } })).toBe(2);
  });

  it('never fabricates e-mails for a site that publishes none', async () => {
    internet.add({
      'https://acme-tech.com/': acmeSite()['https://acme-tech.com/']!,
      'https://acme-tech.com/contact-us':
        '<html><head><title>Contact</title></head><body><form></form></body></html>',
      'https://acme-tech.com/careers':
        '<html><head><title>Careers</title></head><body>No openings</body></html>',
      'https://acme-tech.com/about-us':
        '<html><head><title>About</title></head><body>About us</body></html>',
    });
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://acme-tech.com/',
    });
    const run = await enrich(fx, company.id);

    expect(run.status).toBe('COMPLETED');
    expect(
      await prisma.companyContact.count({ where: { companyId: company.id, kind: 'EMAIL' } }),
    ).toBe(0);
    expect(await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject({
      emailStatus: 'MISSING',
      careersStatus: 'VERIFIED', // the page exists even though it lists nothing
    });
  });
});

describe('rejecting wrong websites', () => {
  it('rejects a candidate that belongs to another company, with evidence, and keeps nothing from it', async () => {
    internet.add(bakerySite());
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://zenith-bakery.com/',
      domain: 'zenith-bakery.com',
      websiteStatus: 'UNVERIFIED',
    });
    await prisma.companyIdentity.create({
      data: {
        companyId: company.id,
        workspaceId: fx.workspaceId,
        type: 'DOMAIN',
        value: 'zenith-bakery.com',
      },
    });

    const run = await enrich(fx, company.id);
    expect(run.status).toBe('COMPLETED');
    expect(run.websiteUrl).toBeNull();

    const review = await prisma.companyReview.findFirstOrThrow({
      where: { companyId: company.id },
    });
    expect(review).toMatchObject({
      decision: 'REJECTED',
      status: 'REJECTED',
      decidedManually: false,
    });
    expect(
      (review.evidence as { signal: string }[]).some((e) => e.signal === 'NAME_NOT_FOUND'),
    ).toBe(true);

    expect(await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject({
      website: null,
      domain: null,
      websiteStatus: 'FAILED',
    });
    expect(await prisma.companyIdentity.count({ where: { companyId: company.id } })).toBe(0);
    expect(await prisma.companyPage.count({ where: { companyId: company.id } })).toBe(0);
    expect(await prisma.companyContact.count({ where: { companyId: company.id } })).toBe(0);
    expect(internet.requested).toEqual(['https://zenith-bakery.com/']); // not crawled
  });

  it('never re-evaluates a candidate a person rejected', async () => {
    internet.add(acmeSite());
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://acme-tech.com/',
    });
    await prisma.companyReview.create({
      data: {
        workspaceId: fx.workspaceId,
        companyId: company.id,
        subjectKey: 'acme-tech.com',
        subjectUrl: 'https://acme-tech.com/',
        decision: 'OFFICIAL',
        confidence: 0.8,
        evidence: [],
        status: 'REJECTED',
        decidedManually: true,
      },
    });
    const run = await enrich(fx, company.id);
    expect(internet.requested).toEqual([]); // not even fetched
    expect(await prisma.companyContact.count({ where: { companyId: company.id } })).toBe(0);
    expect(run.errors).toEqual([expect.objectContaining({ code: 'NO_WEBSITE_CANDIDATE' })]);
    const review = await prisma.companyReview.findFirstOrThrow({
      where: { companyId: company.id },
    });
    expect(review).toMatchObject({ status: 'REJECTED', decidedManually: true });
  });

  it('blocks unsafe candidate URLs and records why', async () => {
    internet.failures.set(
      'https://internal-box.com/',
      new FetchError('resolves to a non-public address', 'BLOCKED_ADDRESS'),
    );
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://internal-box.com/',
    });
    const run = await enrich(fx, company.id);

    expect(run.status).toBe('COMPLETED_WITH_ERRORS');
    expect(run.errors).toEqual([
      expect.objectContaining({ code: 'BLOCKED_ADDRESS', retryable: false }),
    ]);
    const review = await prisma.companyReview.findFirstOrThrow({
      where: { companyId: company.id },
    });
    expect(review).toMatchObject({ decision: 'REJECTED' });
    expect((review.evidence as { signal: string }[])[0]!.signal).toBe('UNSAFE_URL');
    expect(await prisma.companyContact.count({ where: { companyId: company.id } })).toBe(0);
  });

  it('keeps an uncertain site pending for a human instead of guessing', async () => {
    internet.add({
      'https://acme-tech.com/':
        '<html><head><title></title></head><body><div id="root"></div></body></html>',
    });
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://acme-tech.com/',
    });
    await enrich(fx, company.id);

    expect(
      await prisma.companyReview.findFirstOrThrow({ where: { companyId: company.id } }),
    ).toMatchObject({
      decision: 'UNCERTAIN',
      status: 'PENDING',
    });
    expect(await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject({
      website: 'https://acme-tech.com/',
      websiteStatus: 'UNVERIFIED',
    });
    expect(await prisma.companyContact.count({ where: { companyId: company.id } })).toBe(0);
  });

  it('crawls a site a person approved, without re-verifying it', async () => {
    internet.add(acmeSite());
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId);
    await prisma.companyReview.create({
      data: {
        workspaceId: fx.workspaceId,
        companyId: company.id,
        subjectKey: 'acme-tech.com',
        subjectUrl: 'https://acme-tech.com/',
        decision: 'UNCERTAIN',
        confidence: 0.5,
        evidence: [],
        status: 'APPROVED',
        decidedManually: true,
      },
    });
    const run = await enrich(fx, company.id);
    expect(run.status).toBe('COMPLETED');
    expect(await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject({
      website: 'https://acme-tech.com/',
      websiteStatus: 'VERIFIED',
    });
    expect(
      await prisma.companyContact.count({ where: { companyId: company.id, kind: 'EMAIL' } }),
    ).toBe(4);
  });
});

describe('finding a website for a company that has none', () => {
  it('reports the gap instead of inventing a site when nothing can propose one', async () => {
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId);
    const run = await enrich(fx, company.id);
    expect(run.status).toBe('COMPLETED_WITH_ERRORS');
    expect(run.errors).toEqual([expect.objectContaining({ code: 'NO_WEBSITE_CANDIDATE' })]);
    expect(await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject({
      website: null,
      websiteStatus: 'MISSING',
    });
  });

  describe('with a candidate finder', () => {
    beforeAll(() => {
      useFinder = true;
    });
    afterAll(() => {
      useFinder = false;
    });

    it('verifies each proposal and keeps only the one that checks out', async () => {
      internet.add(bakerySite()).add(acmeSite());
      finder.results = [
        'https://www.linkedin.com/company/acme',
        'https://zenith-bakery.com/',
        'https://acme-tech.com/',
      ];
      const fx = await createWorkspace(prisma);
      const company = await createCompany(prisma, fx.workspaceId);
      const run = await enrich(fx, company.id);

      expect(run.status).toBe('COMPLETED');
      expect(finder.calls).toBe(1);
      expect(await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject({
        website: 'https://acme-tech.com/',
        domain: 'acme-tech.com',
        websiteStatus: 'VERIFIED',
      });
      const reviews = await prisma.companyReview.findMany({ where: { companyId: company.id } });
      expect(Object.fromEntries(reviews.map((r) => [r.subjectKey, r.status]))).toEqual({
        'linkedin.com': 'REJECTED',
        'zenith-bakery.com': 'REJECTED',
        'acme-tech.com': 'APPROVED',
      });
      expect(internet.requested.some((u) => u.includes('linkedin.com'))).toBe(false); // never fetched
      expect(
        await prisma.companyIdentity.count({
          where: { companyId: company.id, type: 'DOMAIN', value: 'acme-tech.com' },
        }),
      ).toBe(1);
    });
  });
});

describe('failure tracking', () => {
  it('records page failures and robots blocks, and does not claim "no e-mails" when blocked', async () => {
    internet.add(acmeSite());
    internet.failures.set(
      'https://acme-tech.com/careers',
      new FetchError('HTTP 503', 'HTTP_ERROR', 503),
    );
    internet.failures.set(
      'https://acme-tech.com/contact-us',
      new FetchError('robots', 'ROBOTS_DISALLOWED'),
    );
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://acme-tech.com/',
      emailStatus: 'UNVERIFIED',
    });
    // Pre-existing contact from an earlier crawl must survive a blocked re-crawl.
    await prisma.companyContact.create({
      data: {
        companyId: company.id,
        workspaceId: fx.workspaceId,
        kind: 'EMAIL',
        value: 'old@acme-tech.com',
        confidence: 0.9,
        verificationStatus: 'VERIFIED',
        verificationMethod: 'PUBLISHED_ON_VERIFIED_SITE',
        extractionMethod: 'MAILTO',
        sourceUrl: 'https://acme-tech.com/contact-us',
        extractedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });

    const run = await enrich(fx, company.id);
    expect(run.status).toBe('COMPLETED_WITH_ERRORS');
    expect(run.stats).toMatchObject({ blockedByRobots: 1, failed: 1 });
    expect((run.errors as { code: string }[]).map((e) => e.code).sort()).toEqual([
      'HTTP_ERROR',
      'ROBOTS_DISALLOWED',
    ]);

    const pages = await prisma.companyPage.findMany({ where: { companyId: company.id } });
    expect(pages.find((p) => p.url.endsWith('/careers'))).toMatchObject({
      fetchStatus: 'FAILED',
      httpStatus: 503,
    });
    expect(pages.find((p) => p.url.endsWith('/contact-us'))).toMatchObject({
      fetchStatus: 'BLOCKED_ROBOTS',
    });
    expect(
      await prisma.companyContact.count({
        where: { companyId: company.id, value: 'old@acme-tech.com' },
      }),
    ).toBe(1);
    expect(
      (await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).emailStatus,
    ).toBe('VERIFIED');
  });

  it('retries when every candidate site is unreachable, then fails permanently with the reason', async () => {
    internet.failures.set('https://down-site.com/', new FetchError('Request timed out', 'TIMEOUT'));
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://down-site.com/',
    });
    const run = await createRun(prisma, fx, company.id);

    await expect(processor.process(run.id)).rejects.toBeInstanceOf(RetryableEnrichmentError);
    const mid = await prisma.extractionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(mid.status).toBe('RUNNING');
    expect(mid.errors).toEqual([expect.objectContaining({ code: 'TIMEOUT', retryable: true })]);

    // Through the real queue: attempts are exhausted (ENRICHMENT_MAX_ATTEMPTS=2) → FAILED, lock released.
    await prisma.extractionRun.update({ where: { id: run.id }, data: { status: 'QUEUED' } });
    await queue.ensureJob(run.id);
    const done = await waitForTerminalRun(prisma, run.id);
    expect(done).toMatchObject({ status: 'FAILED', errorCode: 'TIMEOUT', activeKey: null });
    expect(done.attempts).toBeGreaterThanOrEqual(2);
    // …and a new run can start for the company.
    expect(await createRun(prisma, fx, company.id)).toBeTruthy();
  });

  it('fails a run whose company was merged away', async () => {
    const fx = await createWorkspace(prisma);
    const survivor = await createCompany(prisma, fx.workspaceId);
    const merged = await createCompany(prisma, fx.workspaceId, {
      status: 'MERGED',
      mergedIntoId: survivor.id,
    });
    const run = await enrich(fx, merged.id);
    expect(run).toMatchObject({
      status: 'FAILED',
      errorCode: 'COMPANY_UNAVAILABLE',
      activeKey: null,
    });
  });

  it('ignores a redelivered job for a finished run', async () => {
    internet.add(acmeSite());
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://acme-tech.com/',
    });
    const run = await enrich(fx, company.id);
    internet.requested.length = 0;
    await processor.process(run.id);
    expect(internet.requested).toEqual([]);
    expect((await prisma.extractionRun.findUniqueOrThrow({ where: { id: run.id } })).attempts).toBe(
      1,
    );
  });
});

describe('queue delivery', () => {
  it('runs a queued job end to end', async () => {
    internet.add(acmeSite());
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://acme-tech.com/',
    });
    const run = await createRun(prisma, fx, company.id);
    await queue.ensureJob(run.id);
    const done = await waitForTerminalRun(prisma, run.id);
    expect(done.status).toBe('COMPLETED');
    expect(await prisma.companyContact.count({ where: { companyId: company.id } })).toBe(5);
  });

  it('reconciler re-enqueues a run whose job was lost', async () => {
    internet.add(acmeSite());
    const fx = await createWorkspace(prisma);
    const company = await createCompany(prisma, fx.workspaceId, {
      website: 'https://acme-tech.com/',
    });
    const run = await createRun(prisma, fx, company.id); // created by the API, enqueue "lost"
    await new Promise((resolve) => setTimeout(resolve, 1200)); // > ENRICHMENT_RECONCILE_STALE_SECONDS
    expect((await queue.reconcile()).requeued).toBeGreaterThanOrEqual(1);
    expect((await waitForTerminalRun(prisma, run.id)).status).toBe('COMPLETED');
    // nothing left to repair
    expect((await queue.reconcile()).requeued).toBe(0);
  });
});

describe('RedisDomainRateLimiter', () => {
  it('spaces requests to the same registrable domain across callers, not across domains', async () => {
    const limiter = new RedisDomainRateLimiter(redis, 300, `test:rl:${Date.now()}:`);
    const started = Date.now();
    await limiter.acquire('acme-tech.com');
    const afterFirst = Date.now() - started;
    await limiter.acquire('careers.acme-tech.com'); // same registrable domain
    const afterSecond = Date.now() - started;
    expect(afterFirst).toBeLessThan(150);
    expect(afterSecond).toBeGreaterThanOrEqual(280);

    const other = Date.now();
    await limiter.acquire('unrelated-site.com');
    expect(Date.now() - other).toBeLessThan(150);

    // concurrent callers are serialized, not all released at once
    const times: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      [1, 2, 3].map(() =>
        limiter.acquire('burst-site.com').then(() => times.push(Date.now() - t0)),
      ),
    );
    expect(Math.max(...times)).toBeGreaterThanOrEqual(550);
  });

  it('can be cancelled while waiting', async () => {
    const limiter = new RedisDomainRateLimiter(redis, 5000, `test:rl2:${Date.now()}:`);
    await limiter.acquire('slow-site.com');
    const controller = new AbortController();
    const waiting = limiter.acquire('slow-site.com', { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop')), 50);
    await expect(waiting).rejects.toThrow('stop');
  });
});
