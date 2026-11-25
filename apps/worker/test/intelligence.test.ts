import { Test, type TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import type { JobSource, PrismaClient } from '@jobfinder/database';
import { JobAi, type AiProvider, type AiRequest } from '@jobfinder/intelligence';
import type { JobFetchResult, NormalizedJob } from '@jobfinder/jobs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InfrastructureModule, PRISMA } from '../src/infrastructure.module';
import { IntelligenceModule } from '../src/intelligence/intelligence.module';
import { JOB_AI } from '../src/intelligence/intelligence.tokens';
import { IntelligenceService } from '../src/intelligence/intelligence.service';
import { JobAnalyzer } from '../src/intelligence/job-analyzer';
import { MatchProcessor } from '../src/intelligence/match-processor';
import { StatusSweeper } from '../src/intelligence/status-sweeper';
import { persistCheck } from '../src/jobs/job-persister';
import { createCompany, createWorkspace } from './enrichment-helpers';

class FakeAi implements AiProvider {
  readonly id = 'fake';
  readonly model = 'fake-1';
  calls: AiRequest[] = [];
  answers: Record<string, unknown> = {};
  async complete(request: AiRequest): Promise<unknown> {
    this.calls.push(request);
    const answer = this.answers[request.task];
    if (answer === undefined) throw new Error('unavailable');
    return answer;
  }
}
const fake = new FakeAi();

const DESCRIPTION = `Requirements
- 3-5 years of experience in backend development
- Strong knowledge of Node.js and PostgreSQL
Nice to have
- Docker
`;

const posted = (id: string, over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  providerId: 'greenhouse',
  boardKey: 'acme',
  externalId: id,
  title: `Senior Backend Developer ${id}`,
  description: DESCRIPTION,
  location: 'Lahore, Pakistan',
  locations: ['Lahore, Pakistan'],
  department: null,
  employmentType: 'FULL_TIME',
  workplaceType: 'ONSITE',
  applicationUrl: `https://boards.greenhouse.io/acme/jobs/${id}`,
  sourceUrl: `https://boards.greenhouse.io/acme/jobs/${id}`,
  publishedAt: new Date('2026-11-10T00:00:00Z'),
  extraction: 'API',
  ...over,
});
const jobsResult = (jobs: NormalizedJob[], authoritative = true): JobFetchResult => ({
  outcome: 'JOBS',
  jobs,
  pagesFetched: 1,
  authoritative,
});

let moduleRef: TestingModule;
let redis: Redis;
let prisma: PrismaClient;
let analyzer: JobAnalyzer;
let matcher: MatchProcessor;
let sweeper: StatusSweeper;
let service: IntelligenceService;

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  moduleRef = await Test.createTestingModule({
    imports: [InfrastructureModule, IntelligenceModule],
  })
    .overrideProvider(JOB_AI)
    .useValue(null) // rules only, unless a test swaps it
    .compile();
  await moduleRef.init();
  prisma = moduleRef.get<PrismaClient>(PRISMA);
  analyzer = moduleRef.get(JobAnalyzer);
  matcher = moduleRef.get(MatchProcessor);
  sweeper = moduleRef.get(StatusSweeper);
  service = moduleRef.get(IntelligenceService);
});
afterAll(async () => {
  await moduleRef.close();
  redis.disconnect();
});

async function setup() {
  const fx = await createWorkspace(prisma);
  const company = await createCompany(prisma, fx.workspaceId, { website: 'https://acme.com/' });
  const source = await prisma.jobSource.create({
    data: {
      workspaceId: fx.workspaceId,
      companyId: company.id,
      providerId: 'greenhouse',
      boardKey: 'acme',
      boardUrl: 'https://boards.greenhouse.io/acme',
    },
  });
  const run = await prisma.jobRun.create({
    data: { workspaceId: fx.workspaceId, companyId: company.id },
  });
  const check = (src: JobSource, result: JobFetchResult) =>
    persistCheck(prisma, src, run.id, result, new Date());
  return { fx, company, source, check };
}

/** Analyse this source's jobs only (the shared test database holds other tests' pending jobs). */
async function analyzeSource(sourceId: string) {
  const jobs = await prisma.job.findMany({ where: { sourceId, analysisHash: null } });
  for (const j of jobs) await analyzer.analyze(j.id);
  return jobs.length;
}

/** Link the company to a new project the way discovery does (a result in one of its runs). */
async function project(fx: { workspaceId: string; userId: string }, companyId: string, over = {}) {
  const p = await prisma.searchProject.create({
    data: {
      workspaceId: fx.workspaceId,
      createdById: fx.userId,
      name: `p-${Math.random()}`,
      city: 'Lahore',
      industry: 'software',
      keywords: ['software'],
      targetRoles: ['Backend Engineer'],
      targetSkills: ['NodeJS', 'Postgres', 'Kafka'],
      ...over,
    },
  });
  const run = await prisma.searchRun.create({
    data: { projectId: p.id, workspaceId: fx.workspaceId, config: {} },
  });
  const cs = await prisma.companySource.create({
    data: {
      companyId,
      workspaceId: fx.workspaceId,
      providerId: 'fixture',
      sourceKey: `k-${Math.random()}`,
      rawName: 'Acme',
      retrievedAt: new Date(),
    },
  });
  await prisma.discoveryResult.create({
    data: {
      runId: run.id,
      workspaceId: fx.workspaceId,
      companyId,
      companySourceId: cs.id,
      providerId: 'fixture',
      sourceKey: cs.sourceKey,
      outcome: 'CREATED',
    },
  });
  return p;
}

describe('observation history and status', () => {
  it('records every sighting, change and closure; a failed request closes nothing', async () => {
    const { source, check } = await setup();
    await check(source, jobsResult([posted('1'), posted('2')]));
    const one = await prisma.job.findFirstOrThrow({
      where: { sourceId: source.id, externalId: '1' },
    });
    expect(one.status).toBe('OPEN');

    // a failed request and an inconclusive one: no status change, no "missing" observation
    await check(source, {
      outcome: 'FAILED',
      error: { code: 'HTTP_500', message: 'boom', retryable: true },
      jobs: [],
      pagesFetched: 0,
    });
    await check(source, { outcome: 'INCONCLUSIVE', reason: 'unreadable', pagesFetched: 1 });
    expect(
      (await prisma.job.findMany({ where: { sourceId: source.id } })).map((j) => j.status),
    ).toEqual(['OPEN', 'OPEN']);

    // the same job reappears with a new location → CHANGED, analysis invalidated
    await analyzeSource(source.id);
    expect(
      (await prisma.job.findUniqueOrThrow({ where: { id: one.id } })).analysisHash,
    ).not.toBeNull();
    await check(source, jobsResult([posted('1', { location: 'Karachi, Pakistan' }), posted('2')]));
    const changed = await prisma.job.findUniqueOrThrow({ where: { id: one.id } });
    expect(changed.analysisHash).toBeNull();

    // an authoritative answer without job 2 closes it
    await check(source, jobsResult([posted('1', { location: 'Karachi, Pakistan' })]));
    const two = await prisma.job.findFirstOrThrow({
      where: { sourceId: source.id, externalId: '2' },
    });
    expect(two).toMatchObject({
      status: 'CLOSED',
      statusReason: expect.stringMatching(/authoritative/),
    });

    // ...and a NON-authoritative one does not
    await check(source, jobsResult([posted('1', { location: 'Karachi, Pakistan' })], false));
    const kinds = (
      await prisma.jobObservation.findMany({ where: { jobId: one.id }, orderBy: { id: 'asc' } })
    ).map((o) => o.kind);
    expect(kinds[0]).toBe('FIRST_SEEN');
    expect(kinds).toContain('CHANGED');
    expect(kinds).toContain('ANALYZED');

    // history keeps the closed job's whole story, and it can reopen
    const history2 = await prisma.jobObservation.findMany({
      where: { jobId: two.id },
      orderBy: { id: 'asc' },
    });
    expect(history2.map((o) => o.kind)).toEqual([
      'FIRST_SEEN',
      'ANALYZED',
      'SEEN',
      'MISSING',
      'STATUS_CHANGED',
    ]);
    await check(source, jobsResult([posted('1', { location: 'Karachi, Pakistan' }), posted('2')]));
    expect((await prisma.job.findUniqueOrThrow({ where: { id: two.id } })).status).toBe('OPEN');
  });

  it('drops invalid URLs and dates instead of storing them', async () => {
    const { source, check } = await setup();
    await check(
      source,
      jobsResult([
        posted('1', { applicationUrl: 'javascript:alert(1)', publishedAt: new Date('2099-01-01') }),
      ]),
    );
    expect(await prisma.job.findFirstOrThrow({ where: { sourceId: source.id } })).toMatchObject({
      applicationUrl: null,
      publishedAt: null,
    });
  });

  it('expires jobs by their published expiry date and marks long-unconfirmed jobs UNKNOWN, never CLOSED', async () => {
    const { source, check } = await setup();
    await check(
      source,
      jobsResult([posted('1', { expiresAt: new Date(Date.now() + 3_600_000) }), posted('2')]),
    );
    const [a, b] = [
      await prisma.job.findFirstOrThrow({ where: { sourceId: source.id, externalId: '1' } }),
      await prisma.job.findFirstOrThrow({ where: { sourceId: source.id, externalId: '2' } }),
    ];
    const later = new Date(Date.now() + 2 * 3_600_000);
    await sweeper.sweep(later);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('EXPIRED');
    expect((await prisma.job.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('OPEN');

    await sweeper.sweep(new Date(Date.now() + 30 * 86_400_000));
    expect((await prisma.job.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('UNKNOWN');
    // seen again → OPEN
    await check(source, jobsResult([posted('2')]));
    expect((await prisma.job.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('OPEN');
    const trail = await prisma.jobObservation.findMany({
      where: { jobId: b.id, kind: 'STATUS_CHANGED' },
      orderBy: { id: 'asc' },
    });
    expect(trail.map((t) => `${t.fromStatus}>${t.toStatus}`)).toEqual([
      'OPEN>UNKNOWN',
      'UNKNOWN>OPEN',
    ]);
  });
});

describe('analysis', () => {
  it('structures jobs: skills, requirements, seniority, experience; nothing invented', async () => {
    const { source, check } = await setup();
    await check(
      source,
      jobsResult([posted('1'), posted('2', { title: 'Accountant', description: null })]),
    );
    const analyzed = await analyzeSource(source.id);
    expect(analyzed).toBe(2);
    const job = await prisma.job.findFirstOrThrow({
      where: { sourceId: source.id, externalId: '1' },
      include: { skills: true, requirements: true },
    });
    expect(job).toMatchObject({
      normalizedTitle: 'Backend Developer 1',
      seniority: 'SENIOR',
      roleCategory: 'SOFTWARE_ENGINEERING',
      minYearsExperience: 3,
      maxYearsExperience: 5,
      salaryMin: null,
      analysisProvider: 'rules',
    });
    expect(job.skills.map((s) => `${s.skillKey}:${s.kind}`).sort()).toEqual([
      'docker:PREFERRED',
      'nodejs:REQUIRED',
      'postgresql:REQUIRED',
    ]);
    expect(job.requirements.some((r) => r.kind === 'EXPERIENCE' && r.minYears === 3)).toBe(true);
    const bare = await prisma.job.findFirstOrThrow({
      where: { sourceId: source.id, externalId: '2' },
      include: { skills: true },
    });
    expect(bare).toMatchObject({ seniority: 'UNKNOWN', minYearsExperience: null });
    expect(bare.skills).toHaveLength(0);
    // nothing pending → a second pass does no work
    expect(await analyzeSource(source.id)).toBe(0);
  });
});

describe('matching', () => {
  it('scores, explains, is repeatable, and recalculates when preferences change', async () => {
    const { fx, company, source, check } = await setup();
    await check(source, jobsResult([posted('1')]));
    await analyzeSource(source.id);
    const p = await project(fx, company.id);

    const first = await matcher.matchProject(p.id);
    expect(first).toMatchObject({ evaluated: 1, reused: 0, failed: 0 });
    const m = await prisma.jobMatch.findFirstOrThrow({
      where: { projectId: p.id },
      include: { evidence: true },
    });
    expect(m.matchedSkills.sort()).toEqual(['Node.js', 'PostgreSQL']);
    expect(m.missingSkills).toEqual(['Docker']);
    expect(m).toMatchObject({
      provider: 'rules',
      model: 'rules',
      locationFit: 'MATCH',
      experienceFit: 'UNKNOWN',
      explanationSource: 'RULES',
    });
    expect(m.score).toBeGreaterThan(0);
    expect(m.score).toBeLessThanOrEqual(100);
    expect(m.explanation).toMatch(/Docker/);
    expect(m.evidence.length).toBeGreaterThan(0);

    // repeat: nothing recomputed, nothing rewritten
    expect(await matcher.matchProject(p.id)).toMatchObject({ evaluated: 0, reused: 1 });
    const again = await prisma.jobMatch.findFirstOrThrow({ where: { projectId: p.id } });
    expect(again.computedAt).toEqual(m.computedAt);

    // new preferences → recomputed, with a different, bounded score
    await prisma.matchPreference.create({
      data: {
        projectId: p.id,
        workspaceId: fx.workspaceId,
        roleWeight: 0,
        skillsWeight: 1,
        experienceWeight: 0,
        locationWeight: 0,
        yearsExperience: 1,
        version: 1,
      },
    });
    expect(await matcher.matchProject(p.id)).toMatchObject({ evaluated: 1 });
    const updated = await prisma.jobMatch.findFirstOrThrow({ where: { projectId: p.id } });
    expect(updated.score).toBe(80);
    expect(updated.experienceFit).toBe('BELOW');
    expect(updated.inputHash).not.toBe(m.inputHash);
  });

  it('uses validated AI, falls back on bad output, and never re-asks for unchanged inputs', async () => {
    const { fx, company, source, check } = await setup();
    await check(source, jobsResult([posted('1')]));
    await analyzeSource(source.id);
    const p = await project(fx, company.id);

    const ai = new JobAi(fake);
    (matcher as unknown as { ai: JobAi }).ai = ai;
    try {
      fake.calls = [];
      fake.answers = { 'semantic-matching': { similarity: 3, reason: 'out of range' } };
      await matcher.matchProject(p.id);
      let m = await prisma.jobMatch.findFirstOrThrow({ where: { projectId: p.id } });
      expect(m).toMatchObject({ provider: 'rules', semanticScore: null });

      fake.answers = {
        'semantic-matching': { similarity: 0.9, reason: 'same role' },
        'match-explanation': { explanation: 'Strong fit on role and skills; Docker is the gap.' },
      };
      await matcher.matchProject(p.id);
      m = await prisma.jobMatch.findFirstOrThrow({ where: { projectId: p.id } });
      expect(m).toMatchObject({
        provider: 'fake',
        model: 'fake-1',
        semanticScore: 0.9,
        explanationSource: 'AI',
      });
      expect(m.promptVersion).toMatch(/semantic-matching\/v1/);
      expect(m.score).toBeLessThanOrEqual(100);

      const before = fake.calls.length;
      await matcher.matchProject(p.id);
      expect(fake.calls.length).toBe(before); // unchanged → no AI calls
    } finally {
      (matcher as unknown as { ai: JobAi | null }).ai = null;
    }
  });

  it('the sweep analyses pending jobs', async () => {
    const { source, check } = await setup();
    await check(source, jobsResult([posted('9')]));
    const summary = (await service.sweep()) as { analyzed: number };
    expect(summary.analyzed).toBeGreaterThanOrEqual(1);
  });
});
