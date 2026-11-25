import { Test, type TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import type { PrismaClient } from '@jobfinder/database';
import {
  AshbyProvider,
  GenericHtmlJobProvider,
  GreenhouseProvider,
  JobProviderRegistry,
  LeverProvider,
} from '@jobfinder/jobs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAGE_FETCHER } from '../src/enrichment/enrichment.tokens';
import { InfrastructureModule, PRISMA } from '../src/infrastructure.module';
import { JobDiscoveryProcessor } from '../src/jobs/job-discovery-processor';
import { JobQueueService } from '../src/jobs/job-queue.service';
import { JobsModule } from '../src/jobs/jobs.module';
import { JOB_PROVIDER_REGISTRY, RetryableJobError } from '../src/jobs/jobs.tokens';
import { createCompany, createWorkspace, FakeInternet, page } from './enrichment-helpers';

// ---- a scriptable "vendor API": URL prefix → response
const api = new Map<string, () => Response>();
const apiCalls: string[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchImpl = (async (url: string) => {
  apiCalls.push(url);
  const hit = [...api.entries()].find(([prefix]) => url.startsWith(prefix));
  return hit ? hit[1]() : json({}, 404);
}) as never;

const GH = 'https://boards-api.greenhouse.io/v1/boards/';
const LEVER = 'https://api.lever.co/v0/postings/';
const ASHBY = 'https://api.ashbyhq.com/posting-api/job-board/';

const ghJob = (id: number, title = `Engineer ${id}`, location = 'Lahore, Pakistan') => ({
  id,
  title,
  location: { name: location },
  absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}?gh_src=abc&utm_x=1`,
  content: '&lt;p&gt;Do things&lt;/p&gt;',
  first_published: '2026-11-10T04:49:33-05:00',
});
const ghBoard = (...jobs: ReturnType<typeof ghJob>[]) =>
  json({ jobs, meta: { total: jobs.length } });

const internet = new FakeInternet();
let moduleRef: TestingModule;
let redis: Redis;
let prisma: PrismaClient;
let processor: JobDiscoveryProcessor;
let queue: JobQueueService;

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.flushdb();
  const options = { userAgent: 'test', fetchImpl, rateLimiter: { acquire: async () => undefined } };
  const registry = new JobProviderRegistry([
    new GreenhouseProvider(options),
    new LeverProvider(options),
    new AshbyProvider(options),
    new GenericHtmlJobProvider(internet),
  ]);
  moduleRef = await Test.createTestingModule({ imports: [InfrastructureModule, JobsModule] })
    .overrideProvider(PAGE_FETCHER)
    .useValue(internet)
    .overrideProvider(JOB_PROVIDER_REGISTRY)
    .useValue(registry)
    .compile();
  await moduleRef.init();
  prisma = moduleRef.get<PrismaClient>(PRISMA);
  processor = moduleRef.get(JobDiscoveryProcessor);
  queue = moduleRef.get(JobQueueService);
});
afterAll(async () => {
  await moduleRef.close();
  redis.disconnect();
});
beforeEach(() => {
  api.clear();
  apiCalls.length = 0;
  internet.requested.length = 0;
  internet.failures.clear();
  for (const key of Object.keys(internet.sites)) delete internet.sites[key];
});

const home = (links: string) => page('Acme', `<p>Welcome to Acme</p>${links}`);
const site = (links: string, extra: Record<string, string> = {}) =>
  internet.add({ 'https://acme.com/': home(links), ...extra });

async function setup(extra: Record<string, unknown> = {}) {
  const fx = await createWorkspace(prisma);
  const company = await createCompany(prisma, fx.workspaceId, {
    website: 'https://acme.com/',
    domain: 'acme.com',
    websiteStatus: 'VERIFIED',
    ...extra,
  });
  return { fx, company };
}

async function run(fx: { workspaceId: string; userId: string }, companyId: string) {
  const r = await prisma.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      companyId,
      requestedById: fx.userId,
      activeKey: companyId,
    },
  });
  await processor.process(r.id);
  return prisma.jobRun.findUniqueOrThrow({ where: { id: r.id } });
}
const jobsOf = (companyId: string) =>
  prisma.job.findMany({ where: { companyId }, orderBy: { title: 'asc' } });

describe('Greenhouse via a careers link', () => {
  it('discovers the board, fetches, normalizes and keeps the source and original URLs', async () => {
    site('<a href="https://boards.greenhouse.io/acme">Careers</a>');
    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1), ghJob(2)));
    const { fx, company } = await setup();

    const result = await run(fx, company.id);
    expect(result).toMatchObject({
      status: 'COMPLETED',
      activeKey: null,
      sourcesChecked: 1,
      jobsFound: 2,
      careerPagesFound: 1,
    });

    const [source] = await prisma.jobSource.findMany({ where: { companyId: company.id } });
    expect(source).toMatchObject({
      providerId: 'greenhouse',
      boardKey: 'acme',
      status: 'ACTIVE',
      lastOutcome: 'JOBS',
      consecutiveFailures: 0,
    });
    expect(source!.discoveredFromUrl).toContain('greenhouse');
    expect(source!.discoveryEvidence).toMatch(/greenhouse/);

    const jobs = await jobsOf(company.id);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      sourceId: source!.id,
      externalId: '1',
      title: 'Engineer 1',
      location: 'Lahore, Pakistan',
      description: 'Do things',
      status: 'OPEN',
      extraction: 'API',
      // the application URL is exactly what the provider published — query string and all
      applicationUrl: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=abc&utm_x=1',
    });
    const check = await prisma.jobCheck.findFirstOrThrow({ where: { sourceId: source!.id } });
    expect(check).toMatchObject({
      outcome: 'JOBS',
      authoritative: true,
      jobsFound: 2,
      jobsCreated: 2,
      runId: result.id,
    });
    expect(
      (await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).careersStatus,
    ).toBe('VERIFIED');
    expect(
      await prisma.companyPage.count({ where: { companyId: company.id, type: 'CAREERS' } }),
    ).toBe(1);
  });

  it('is idempotent, and closes a job only when the API stops listing it', async () => {
    site('<a href="https://boards.greenhouse.io/acme">Careers</a>');
    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1), ghJob(2)));
    const { fx, company } = await setup();
    await run(fx, company.id);
    await run(fx, company.id);
    expect(await jobsOf(company.id)).toHaveLength(2); // no duplicates
    expect(await prisma.jobSource.count({ where: { companyId: company.id } })).toBe(1);
    expect(await prisma.jobCheck.count({ where: { companyId: company.id } })).toBe(2);
    const second = await prisma.jobCheck.findFirstOrThrow({
      where: { companyId: company.id },
      orderBy: { startedAt: 'desc' },
    });
    expect(second).toMatchObject({ jobsCreated: 0, jobsUpdated: 0, jobsClosed: 0 });

    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1, 'Engineer 1 (renamed)')));
    await run(fx, company.id);
    const jobs = await jobsOf(company.id);
    expect(jobs.map((j) => [j.externalId, j.status, j.title])).toEqual([
      ['1', 'OPEN', 'Engineer 1 (renamed)'],
      ['2', 'CLOSED', 'Engineer 2'],
    ]);
    expect(jobs[1]!.closedAt).toBeInstanceOf(Date);

    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1, 'Engineer 1 (renamed)'), ghJob(2))); // reposted
    await run(fx, company.id);
    expect(
      (await jobsOf(company.id)).every((j) => j.status === 'OPEN' && j.closedAt === null),
    ).toBe(true);
  });

  it('a failed check is recorded as FAILED and never closes jobs or means "no openings"', async () => {
    site('<a href="https://boards.greenhouse.io/acme">Careers</a>');
    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1), ghJob(2)));
    const { fx, company } = await setup();
    await run(fx, company.id);

    api.set(`${GH}acme/jobs`, () => json({}, 503));
    const failing = await prisma.jobRun.create({
      data: { workspaceId: fx.workspaceId, companyId: company.id, activeKey: company.id },
    });
    await expect(processor.process(failing.id)).rejects.toBeInstanceOf(RetryableJobError); // nothing learned: retry

    expect((await jobsOf(company.id)).map((j) => j.status)).toEqual(['OPEN', 'OPEN']);
    const [source] = await prisma.jobSource.findMany({ where: { companyId: company.id } });
    expect(source).toMatchObject({ lastOutcome: 'FAILED', consecutiveFailures: 1 });
    expect(source!.lastSuccessAt).toBeInstanceOf(Date); // the earlier success is remembered
    const check = await prisma.jobCheck.findFirstOrThrow({
      where: { sourceId: source!.id, outcome: 'FAILED' },
    });
    expect(check).toMatchObject({
      errorCode: 'UNAVAILABLE',
      retryable: true,
      httpStatus: 503,
      authoritative: false,
      jobsClosed: 0,
    });
    expect((await prisma.jobRun.findUniqueOrThrow({ where: { id: failing.id } })).errors).toEqual([
      expect.objectContaining({ retryable: true }),
    ]);
  });

  it('an empty board is NO_OPENINGS (and closes what it used to list); a missing board is a failure', async () => {
    site('<a href="https://boards.greenhouse.io/acme">Careers</a>');
    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1)));
    const { fx, company } = await setup();
    await run(fx, company.id);

    api.set(`${GH}acme/jobs`, () => ghBoard());
    const empty = await run(fx, company.id);
    expect(empty.status).toBe('COMPLETED'); // a clean "none" is not an error
    expect((await jobsOf(company.id))[0]).toMatchObject({ status: 'CLOSED' });
    expect(
      await prisma.jobCheck.findFirstOrThrow({
        where: { companyId: company.id },
        orderBy: { startedAt: 'desc' },
      }),
    ).toMatchObject({
      outcome: 'NO_OPENINGS',
      authoritative: true,
      jobsClosed: 1,
    });

    api.set(`${GH}acme/jobs`, () => json({}, 404));
    const gone = await run(fx, company.id);
    expect(gone.status).toBe('COMPLETED_WITH_ERRORS');
    expect(gone.errors).toEqual([
      expect.objectContaining({ code: 'BOARD_NOT_FOUND', retryable: false }),
    ]);
  });
});

describe('other ATS platforms and embeds', () => {
  it('finds Lever and Ashby boards embedded on the careers page and reads both', async () => {
    site('<a href="/careers">Careers</a>', {
      'https://acme.com/careers': page(
        'Careers at Acme',
        `<h1>Careers</h1><p>We are hiring! See our open positions.</p>
         <iframe src="https://jobs.lever.co/acme-lever"></iframe>
         <script src="https://jobs.ashbyhq.com/acme-ashby/embed"></script>
         <a href="https://apply.workable.com/acme-wk/">Other jobs</a>`,
      ),
    });
    api.set(`${LEVER}acme-lever`, () =>
      json([
        {
          id: 'l-1',
          text: 'Lever Role',
          categories: { commitment: 'Full-time', location: 'Karachi', allLocations: ['Karachi'] },
          workplaceType: 'remote',
          descriptionPlain: 'desc',
          hostedUrl: 'https://jobs.lever.co/acme-lever/l-1',
          applyUrl: 'https://jobs.lever.co/acme-lever/l-1/apply',
          createdAt: 1788199939703,
        },
      ]),
    );
    api.set(`${ASHBY}acme-ashby`, () =>
      json({
        jobs: [
          {
            id: 'a-1',
            title: 'Ashby Role',
            location: 'Remote',
            employmentType: 'Intern',
            workplaceType: 'Remote',
            jobUrl: 'https://jobs.ashbyhq.com/acme-ashby/a-1',
            applyUrl: 'https://jobs.ashbyhq.com/acme-ashby/a-1/application',
            publishedAt: '2026-01-02T00:00:00Z',
            isListed: true,
          },
        ],
      }),
    );
    const { fx, company } = await setup();
    const result = await run(fx, company.id);

    const sources = await prisma.jobSource.findMany({
      where: { companyId: company.id },
      orderBy: { providerId: 'asc' },
    });
    expect(sources.map((s) => [s.providerId, s.boardKey, s.status])).toEqual([
      ['ashby', 'acme-ashby', 'ACTIVE'],
      ['lever', 'acme-lever', 'ACTIVE'],
      ['workable', 'apply.workable.com/acme-wk', 'UNSUPPORTED'], // recognised, never read
    ]);
    expect(await jobsOf(company.id)).toEqual([
      expect.objectContaining({
        title: 'Ashby Role',
        employmentType: 'INTERNSHIP',
        workplaceType: 'REMOTE',
      }),
      expect.objectContaining({
        title: 'Lever Role',
        employmentType: 'FULL_TIME',
        workplaceType: 'REMOTE',
      }),
    ]);
    expect(result).toMatchObject({ status: 'COMPLETED', sourcesChecked: 2 });
    expect(apiCalls.some((u) => u.includes('workable'))).toBe(false);
    expect(internet.requested.some((u) => u.includes('workable'))).toBe(false);
    expect(await prisma.jobCheck.count({ where: { sourceId: sources[2]!.id } })).toBe(0);
  });
});

describe('generic career pages', () => {
  const careers = (body: string) => ({
    'https://acme.com/careers': page(
      'Careers at Acme',
      `<h1>Careers</h1><p>We are hiring! Open positions below. Apply now.</p>${body}`,
    ),
  });
  const list = `<ul>${[1, 2, 3].map((n) => `<li><a href="/jobs/role-${n}"><h3>Support Agent ${n}</h3></a><span class="location">Lahore</span> Full-time</li>`).join('')}</ul>`;

  it('parses a plain HTML listing; generic results never close jobs', async () => {
    site('<a href="/careers">Careers</a>', careers(list));
    const { fx, company } = await setup();
    const first = await run(fx, company.id);
    expect(first.status).toBe('COMPLETED');
    const [source] = await prisma.jobSource.findMany({ where: { companyId: company.id } });
    expect(source).toMatchObject({
      providerId: 'generic-html',
      boardKey: 'https://acme.com/careers',
    });
    const jobs = await jobsOf(company.id);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      extraction: 'HTML',
      employmentType: 'FULL_TIME',
      location: 'Lahore',
      applicationUrl: 'https://acme.com/jobs/role-1',
    });
    expect(
      await prisma.jobCheck.findFirstOrThrow({ where: { sourceId: source!.id } }),
    ).toMatchObject({ outcome: 'JOBS', authoritative: false });

    // page now shows only one job (partial parse / different state): the others stay OPEN
    internet.add(careers(list.replace(/<li>.*?role-[23].*?<\/li>/g, '')));
    internet.add(
      careers(
        `<ul><li><a href="/jobs/role-1"><h3>Support Agent 1</h3></a></li><li><a href="/jobs/role-9"><h3>Support Agent 9</h3></a></li></ul>`,
      ),
    );
    await run(fx, company.id);
    expect((await jobsOf(company.id)).filter((j) => j.status === 'OPEN')).toHaveLength(4);
  });

  it('an unreadable page is INCONCLUSIVE, an explicit "none" is NO_OPENINGS, a failed fetch is FAILED', async () => {
    const { fx, company } = await setup();
    site('<a href="/careers">Careers</a>', careers('<div id="app">Loading…</div>'));
    const inconclusive = await run(fx, company.id);
    expect(inconclusive.status).toBe('COMPLETED_WITH_ERRORS');
    const [source] = await prisma.jobSource.findMany({ where: { companyId: company.id } });
    expect(
      await prisma.jobCheck.findFirstOrThrow({ where: { sourceId: source!.id } }),
    ).toMatchObject({ outcome: 'INCONCLUSIVE' });
    expect(source!.lastSuccessAt).toBeNull(); // we still do not know

    internet.add(
      careers('<p>Sorry, there are no open positions at the moment. Check back soon.</p>'),
    );
    await run(fx, company.id);
    expect(
      (
        await prisma.jobCheck.findFirstOrThrow({
          where: { sourceId: source!.id },
          orderBy: { startedAt: 'desc' },
        })
      ).outcome,
    ).toBe('NO_OPENINGS');
    expect(
      (await prisma.jobSource.findUniqueOrThrow({ where: { id: source!.id } })).lastSuccessAt,
    ).toBeInstanceOf(Date);
  });
});

describe('duplicate prevention across sources', () => {
  const careersWithBoth = {
    'https://acme.com/careers': page(
      'Careers',
      `<h1>Careers</h1><p>We are hiring! Open positions. Apply now.</p><ul><li><a href="/jobs/senior-engineer"><h3>Senior Engineer</h3></a><span class="location">Lahore</span></li><li><a href="/jobs/designer"><h3>Product Designer</h3></a><span class="location">Karachi</span></li></ul>`,
    ),
  };

  it('a scraped job already provided by an official ATS is not imported, and an ATS job supersedes a scraped twin', async () => {
    const { fx, company } = await setup();
    // 1. scraped page first
    site('<a href="/careers">Careers</a>', careersWithBoth);
    await run(fx, company.id);
    expect((await jobsOf(company.id)).map((j) => j.status)).toEqual(['OPEN', 'OPEN']);

    // 2. the company now also lists an ATS board that carries "Senior Engineer / Lahore"
    site(
      '<a href="/careers">Careers</a><a href="https://boards.greenhouse.io/acme">Jobs</a>',
      careersWithBoth,
    );
    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(7, 'Senior Engineer', 'Lahore')));
    await run(fx, company.id);
    const jobs = await prisma.job.findMany({
      where: { companyId: company.id },
      include: { source: true },
      orderBy: { title: 'asc' },
    });
    const open = jobs
      .filter((j) => j.status === 'OPEN')
      .map((j) => `${j.source.providerId}:${j.title}`)
      .sort();
    expect(open).toEqual(['generic-html:Product Designer', 'greenhouse:Senior Engineer']); // one OPEN "Senior Engineer"
    expect(
      jobs.find((j) => j.source.providerId === 'generic-html' && j.title === 'Senior Engineer')
        ?.status,
    ).toBe('CLOSED');

    // 3. running again does not resurrect or duplicate anything
    await run(fx, company.id);
    expect(
      (await prisma.job.findMany({ where: { companyId: company.id, status: 'OPEN' } })).length,
    ).toBe(2);
    expect(await prisma.job.count({ where: { companyId: company.id } })).toBe(3);
  });

  it('the database refuses the same job twice for one source', async () => {
    site('<a href="https://boards.greenhouse.io/acme">Careers</a>');
    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1), ghJob(1)));
    const { fx, company } = await setup();
    await run(fx, company.id);
    expect(await jobsOf(company.id)).toHaveLength(1);
    const job = (await jobsOf(company.id))[0]!;
    await expect(
      prisma.job.create({
        data: {
          workspaceId: fx.workspaceId,
          companyId: company.id,
          sourceId: job.sourceId,
          externalId: job.externalId,
          fingerprint: 'x',
          title: 'dup',
          sourceUrl: 'https://x.com',
          extraction: 'API',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('when nothing can be found', () => {
  it('says so explicitly instead of implying zero vacancies', async () => {
    site('<a href="/about">About</a>');
    const { fx, company } = await setup();
    const result = await run(fx, company.id);
    expect(result.status).toBe('COMPLETED_WITH_ERRORS');
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'NO_JOB_SOURCE_FOUND',
        message: expect.stringMatching(/does not mean/),
      }),
    ]);
    expect(await prisma.job.count({ where: { companyId: company.id } })).toBe(0);
    expect(await prisma.jobCheck.count({ where: { companyId: company.id } })).toBe(0);
  });

  it('does not crawl without a verified website', async () => {
    const { fx, company } = await setup({ websiteStatus: 'UNVERIFIED' });
    const result = await run(fx, company.id);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'NO_VERIFIED_WEBSITE' })]),
    );
    expect(internet.requested).toEqual([]);
  });

  it('keeps refreshing earlier sources when career page discovery itself fails', async () => {
    site('<a href="https://boards.greenhouse.io/acme">Careers</a>');
    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1)));
    const { fx, company } = await setup();
    await run(fx, company.id);
    internet.failures.set(
      'https://acme.com/',
      new (await import('@jobfinder/enrichment')).FetchError('Request timed out', 'TIMEOUT'),
    );
    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1), ghJob(2)));
    const result = await run(fx, company.id);
    expect(result.status).toBe('COMPLETED_WITH_ERRORS');
    expect((await jobsOf(company.id)).length).toBe(2);
  });

  it('fails a run whose company was merged away', async () => {
    const fx = await createWorkspace(prisma);
    const survivor = await createCompany(prisma, fx.workspaceId);
    const merged = await createCompany(prisma, fx.workspaceId, {
      status: 'MERGED',
      mergedIntoId: survivor.id,
    });
    expect(await run(fx, merged.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'COMPANY_UNAVAILABLE',
      activeKey: null,
    });
  });
});

describe('queue delivery', () => {
  it('runs a queued job end to end and fails permanently after the attempts are used', async () => {
    site('<a href="https://boards.greenhouse.io/acme">Careers</a>');
    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1)));
    const { fx, company } = await setup();
    const ok = await prisma.jobRun.create({
      data: { workspaceId: fx.workspaceId, companyId: company.id, activeKey: company.id },
    });
    await queue.ensureJob(ok.id);
    expect((await waitForRun(ok.id)).status).toBe('COMPLETED');

    api.set(`${GH}acme/jobs`, () => json({}, 503));
    const bad = await prisma.jobRun.create({
      data: { workspaceId: fx.workspaceId, companyId: company.id, activeKey: company.id },
    });
    await queue.ensureJob(bad.id);
    expect(await waitForRun(bad.id)).toMatchObject({
      status: 'FAILED',
      activeKey: null,
      errorCode: 'UNAVAILABLE',
    });
    expect((await jobsOf(company.id))[0]!.status).toBe('OPEN'); // still not "closed"
  });

  it('reconciler re-enqueues a run whose job was lost', async () => {
    site('<a href="https://boards.greenhouse.io/acme">Careers</a>');
    api.set(`${GH}acme/jobs`, () => ghBoard(ghJob(1)));
    const { fx, company } = await setup();
    const lost = await prisma.jobRun.create({
      data: { workspaceId: fx.workspaceId, companyId: company.id, activeKey: company.id },
    });
    await new Promise((r) => setTimeout(r, 1200));
    expect((await queue.reconcile()).requeued).toBeGreaterThanOrEqual(1);
    expect((await waitForRun(lost.id)).status).toBe('COMPLETED');
  });
});

async function waitForRun(id: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const r = await prisma.jobRun.findUniqueOrThrow({ where: { id } });
    if (['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(r.status)) return r;
    if (Date.now() > deadline) throw new Error(`run stuck in ${r.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
