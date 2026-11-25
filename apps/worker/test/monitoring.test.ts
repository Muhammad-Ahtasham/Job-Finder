import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@jobfinder/database';
import { FetchError, type PageFetcher, type SafeFetchResult } from '@jobfinder/enrichment';
import {
  JobProviderRegistry,
  type JobDiscoveryProvider,
  type JobFetchResult,
  type NormalizedJob,
} from '@jobfinder/jobs';
import {
  DEFAULT_INTERVALS,
  ensureCompanySchedules,
  setCompanyMonitoring,
  type NotificationChannel,
  type NotificationEvent,
} from '@jobfinder/monitoring';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGE_FETCHER } from '../src/enrichment/enrichment.tokens';
import { InfrastructureModule, PRISMA } from '../src/infrastructure.module';
import { JOB_PROVIDER_REGISTRY } from '../src/jobs/jobs.tokens';
import { MonitoringModule } from '../src/monitoring/monitoring.module';
import { MonitoringProcessor } from '../src/monitoring/monitoring-processor';
import { MonitoringQueueService } from '../src/monitoring/monitoring-queue.service';
import { NotificationService } from '../src/monitoring/notification.service';
import { createCompany, createWorkspace } from './enrichment-helpers';

// ---- a vendor whose answers the test scripts
class ScriptedProvider implements JobDiscoveryProvider {
  readonly id = 'greenhouse';
  readonly displayName = 'Scripted';
  readonly terms = { docsUrl: 'https://example.test', reviewedAt: '2026-01-01' };
  next: () => JobFetchResult = () => ({
    outcome: 'JOBS',
    jobs: [],
    pagesFetched: 1,
    authoritative: true,
  });
  calls = 0;
  identify() {
    return null;
  }
  async fetchJobs(): Promise<JobFetchResult> {
    this.calls += 1;
    return this.next();
  }
}
const provider = new ScriptedProvider();

const job = (id: string, over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  providerId: 'greenhouse',
  boardKey: 'acme',
  externalId: id,
  title: `Engineer ${id}`,
  description: 'Do things',
  location: 'Lahore',
  locations: ['Lahore'],
  department: null,
  employmentType: 'FULL_TIME',
  workplaceType: 'ONSITE',
  applicationUrl: `https://boards.greenhouse.io/acme/jobs/${id}`,
  sourceUrl: `https://boards.greenhouse.io/acme/jobs/${id}`,
  publishedAt: new Date('2026-11-10T00:00:00Z'),
  extraction: 'API',
  ...over,
});
const board = (jobs: NormalizedJob[], authoritative = true): JobFetchResult => ({
  outcome: 'JOBS',
  jobs,
  pagesFetched: 1,
  authoritative,
});
const failed = (code = 'HTTP_500'): JobFetchResult => ({
  outcome: 'FAILED',
  error: { code, message: 'the vendor is down', retryable: true },
  jobs: [],
  pagesFetched: 0,
});

// ---- a website the test scripts
class ScriptedSite implements PageFetcher {
  error: FetchError | null = null;
  finalUrl: string | null = null;
  body = '<html><body><h1>Acme</h1><p>We build things.</p></body></html>';
  async fetchText(url: string | URL): Promise<SafeFetchResult> {
    if (this.error) throw this.error;
    const requested = typeof url === 'string' ? url : url.href;
    return {
      url: this.finalUrl ?? requested,
      status: 200,
      contentType: 'text/html',
      body: this.body,
      bytes: this.body.length,
      redirects: [],
    };
  }
}
const site = new ScriptedSite();

let moduleRef: TestingModule;
let prisma: PrismaClient;
let processor: MonitoringProcessor;
let queue: MonitoringQueueService;
let notifications: NotificationService;

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({ imports: [InfrastructureModule, MonitoringModule] })
    .overrideProvider(PAGE_FETCHER)
    .useValue(site)
    .overrideProvider(JOB_PROVIDER_REGISTRY)
    .useValue(new JobProviderRegistry([provider]))
    .compile();
  await moduleRef.init();
  prisma = moduleRef.get<PrismaClient>(PRISMA);
  processor = moduleRef.get(MonitoringProcessor);
  queue = moduleRef.get(MonitoringQueueService);
  notifications = moduleRef.get(NotificationService);
});
afterAll(async () => {
  await moduleRef.close();
});

async function setup(companyExtra: Record<string, unknown> = {}) {
  provider.next = () => board([]);
  site.error = null;
  site.finalUrl = null;
  const fx = await createWorkspace(prisma);
  // a second member, to see notifications reach everyone who wants them
  const other = await prisma.user.create({
    data: { email: `m-${randomUUID()}@example.test`, name: 'Other', passwordHash: 'x' },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: fx.workspaceId, userId: other.id, role: 'MEMBER' },
  });
  const company = await createCompany(prisma, fx.workspaceId, {
    website: 'https://acme.example/',
    domain: 'acme.example',
    websiteStatus: 'VERIFIED',
    ...companyExtra,
  });
  const source = await prisma.jobSource.create({
    data: {
      workspaceId: fx.workspaceId,
      companyId: company.id,
      providerId: 'greenhouse',
      boardKey: 'acme',
      boardUrl: 'https://boards.greenhouse.io/acme',
    },
  });
  await ensureCompanySchedules(prisma, company, {
    intervals: DEFAULT_INTERVALS,
    random: () => 0.5,
  });
  const schedule = await prisma.monitoringSchedule.findFirstOrThrow({
    where: { jobSourceId: source.id },
  });
  const website = await prisma.monitoringSchedule.findFirst({
    where: { companyId: company.id, kind: 'WEBSITE' },
  });
  return { fx, other: other.id, company, source, schedule, website };
}

const run = (id: string) => processor.run(id);
const jobsOf = (companyId: string) =>
  prisma.job.findMany({ where: { companyId }, orderBy: { title: 'asc' } });
const schedule = (id: string) => prisma.monitoringSchedule.findUniqueOrThrow({ where: { id } });
const notes = (workspaceId: string, userId?: string) =>
  prisma.notification.findMany({
    where: { workspaceId, ...(userId ? { userId } : {}) },
    orderBy: { id: 'asc' },
  });
const minutesFromNow = (d: Date) => (d.getTime() - Date.now()) / 60_000;

describe('schedules', () => {
  it('are created for a company with the documented default frequencies, and never overwritten', async () => {
    const { company, schedule: ats, website } = await setup();
    expect(ats).toMatchObject({ kind: 'ATS_BOARD', intervalMinutes: 720, enabled: true });
    expect(website).toMatchObject({ kind: 'WEBSITE', intervalMinutes: 10_080, enabled: true });
    expect(minutesFromNow(ats.nextRunAt)).toBeGreaterThan(700);

    await prisma.monitoringSchedule.update({
      where: { id: ats.id },
      data: { intervalMinutes: 90, enabled: false },
    });
    expect(
      (await ensureCompanySchedules(prisma, company, { intervals: DEFAULT_INTERVALS })).created,
    ).toBe(0);
    expect(await schedule(ats.id)).toMatchObject({ intervalMinutes: 90, enabled: false });

    // a custom career page is a CAREER_PAGE schedule with its own default
    const page = await prisma.jobSource.create({
      data: {
        workspaceId: company.workspaceId,
        companyId: company.id,
        providerId: 'generic-html',
        boardKey: 'https://acme.example/careers',
        boardUrl: 'https://acme.example/careers',
      },
    });
    await ensureCompanySchedules(prisma, company, { intervals: DEFAULT_INTERVALS });
    expect(
      await prisma.monitoringSchedule.findFirstOrThrow({ where: { jobSourceId: page.id } }),
    ).toMatchObject({
      kind: 'CAREER_PAGE',
      intervalMinutes: 1440,
    });
  });

  it('can be turned off and on for a company', async () => {
    const { company, schedule: ats, website } = await setup();
    await setCompanyMonitoring(prisma, company, false, { intervals: DEFAULT_INTERVALS });
    expect((await schedule(ats.id)).enabled).toBe(false);
    expect((await schedule(website!.id)).enabled).toBe(false);
    // a source found while the company is paused starts paused too
    const extra = await prisma.jobSource.create({
      data: {
        workspaceId: company.workspaceId,
        companyId: company.id,
        providerId: 'lever',
        boardKey: 'acme',
        boardUrl: 'https://jobs.lever.co/acme',
      },
    });
    await ensureCompanySchedules(prisma, company, { intervals: DEFAULT_INTERVALS });
    expect(
      (await prisma.monitoringSchedule.findFirstOrThrow({ where: { jobSourceId: extra.id } }))
        .enabled,
    ).toBe(false);

    await setCompanyMonitoring(prisma, company, true, { intervals: DEFAULT_INTERVALS });
    expect(
      (await prisma.monitoringSchedule.findMany({ where: { companyId: company.id } })).every(
        (s) => s.enabled,
      ),
    ).toBe(true);
  });
});

describe('scheduled ATS checks', () => {
  it('discover new jobs without duplicating, and announce them once', async () => {
    const { fx, other, company, schedule: s } = await setup();

    // the first check is a baseline: its jobs are recorded, not announced
    provider.next = () => board([job('1'), job('2')]);
    expect(await run(s.id)).toMatchObject({ outcome: 'JOBS' });
    expect(await jobsOf(company.id)).toHaveLength(2);
    expect(await notes(fx.workspaceId)).toHaveLength(0);
    expect(await schedule(s.id)).toMatchObject({ lastOutcome: 'JOBS', consecutiveFailures: 0 });
    expect((await schedule(s.id)).lastSuccessAt).not.toBeNull();
    expect(await prisma.jobCheck.findFirstOrThrow({ where: { scheduleId: s.id } })).toMatchObject({
      trigger: 'SCHEDULED',
      runId: null,
      outcome: 'JOBS',
      authoritative: true,
    });

    // a new vacancy appears
    provider.next = () => board([job('1'), job('2'), job('3')]);
    await run(s.id);
    expect(await jobsOf(company.id)).toHaveLength(3);
    const sent = await notes(fx.workspaceId);
    expect(sent.map((n) => [n.type, n.userId].join(':')).sort()).toEqual(
      [`NEW_JOB:${fx.userId}`, `NEW_JOB:${other}`].sort(),
    );
    expect(sent[0]).toMatchObject({
      title: expect.stringContaining('New job'),
      body: expect.stringContaining('Engineer 3'),
    });
    expect(sent[0]!.deliveredChannels).toEqual(['in_app']);

    // the same answer again: no duplicate job, no duplicate notification
    await run(s.id);
    await run(s.id);
    expect(await jobsOf(company.id)).toHaveLength(3);
    expect(await notes(fx.workspaceId)).toHaveLength(2);
    expect(await prisma.job.count({ where: { companyId: company.id, status: 'OPEN' } })).toBe(3);
  });

  it('record material changes, and announce them', async () => {
    const { fx, company, schedule: s } = await setup();
    provider.next = () => board([job('1')]);
    await run(s.id);
    provider.next = () => board([job('1', { title: 'Staff Engineer 1', location: 'Karachi' })]);
    await run(s.id);
    const [j] = await jobsOf(company.id);
    const history = await prisma.jobObservation.findMany({
      where: { jobId: j!.id, kind: 'CHANGED' },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ reason: 'material change: title, location' });
    expect(history[0]!.changes).toMatchObject({
      title: { from: 'Engineer 1', to: 'Staff Engineer 1' },
    });
    const sent = (await notes(fx.workspaceId)).filter((n) => n.type === 'JOB_CHANGED');
    expect(sent).toHaveLength(2); // one per member
    expect(sent[0]!.body).toContain('changed: title, location');
    // a non-material edit (description only) is recorded but not announced
    provider.next = () =>
      board([
        job('1', { title: 'Staff Engineer 1', location: 'Karachi', description: 'New text' }),
      ]);
    await run(s.id);
    expect((await notes(fx.workspaceId)).filter((n) => n.type === 'JOB_CHANGED')).toHaveLength(2);
    expect(await prisma.jobObservation.count({ where: { jobId: j!.id, kind: 'CHANGED' } })).toBe(2);
  });

  it('do not close jobs after a temporary failure, and keep provider errors apart', async () => {
    const { fx, company, schedule: s } = await setup();
    provider.next = () => board([job('1'), job('2')]);
    await run(s.id);
    const lastSuccess = (await schedule(s.id)).lastSuccessAt!;

    for (const n of [1, 2, 3]) {
      provider.next = () => failed();
      expect(await run(s.id)).toMatchObject({ outcome: 'FAILED' });
      const after = await schedule(s.id);
      expect(after).toMatchObject({
        consecutiveFailures: n,
        lastErrorCode: 'HTTP_500',
        lastOutcome: 'FAILED',
      });
      expect(after.lastErrorMessage).toMatch(/vendor is down/);
      // retried sooner than the 12 h interval, with backoff, and the last success is untouched
      expect(minutesFromNow(after.nextRunAt)).toBeLessThan(720);
      expect(after.lastSuccessAt).toEqual(lastSuccess);
    }
    expect((await jobsOf(company.id)).map((j) => j.status)).toEqual(['OPEN', 'OPEN']);
    expect((await jobsOf(company.id)).every((j) => j.missedChecks === 0)).toBe(true);
    expect(await notes(fx.workspaceId)).toHaveLength(0);
    // the failures are on the checks, not on the jobs
    const checks = await prisma.jobCheck.findMany({
      where: { scheduleId: s.id, outcome: 'FAILED' },
    });
    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.errorCode === 'HTTP_500' && c.jobsMissing === 0)).toBe(true);

    // an answer that is NOT authoritative (a partial page) cannot close anything either
    provider.next = () => board([job('1')], false);
    await run(s.id);
    expect((await jobsOf(company.id)).map((j) => j.status)).toEqual(['OPEN', 'OPEN']);

    // recovery
    provider.next = () => board([job('1'), job('2')]);
    await run(s.id);
    expect(await schedule(s.id)).toMatchObject({ consecutiveFailures: 0, lastOutcome: 'JOBS' });
  });

  it('close a missing job only after a confirming check, and look again soon', async () => {
    const { fx, company, schedule: s } = await setup();
    provider.next = () => board([job('1'), job('2')]);
    await run(s.id);

    provider.next = () => board([job('1')]);
    await run(s.id);
    const two = (await jobsOf(company.id)).find((j) => j.externalId === '2')!;
    expect(two).toMatchObject({ status: 'OPEN', missedChecks: 1 });
    expect(
      await prisma.jobCheck.findFirstOrThrow({
        where: { scheduleId: s.id },
        orderBy: { id: 'desc' },
      }),
    ).toMatchObject({
      jobsMissing: 1,
      pendingConfirmation: 1,
      jobsClosed: 0,
    });
    // looked at again in ~30 minutes, not 12 hours
    expect(minutesFromNow((await schedule(s.id)).nextRunAt)).toBeLessThan(35);
    expect((await notes(fx.workspaceId)).filter((n) => n.type === 'JOB_CLOSED')).toHaveLength(0);

    // the job comes back: the count is void
    provider.next = () => board([job('1'), job('2')]);
    await run(s.id);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: two.id } })).toMatchObject({
      status: 'OPEN',
      missedChecks: 0,
    });

    // missing twice in a row: closed, announced once per member
    provider.next = () => board([job('1')]);
    await run(s.id);
    await run(s.id);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: two.id } })).toMatchObject({
      status: 'CLOSED',
      missedChecks: 2,
    });
    const closed = (await notes(fx.workspaceId)).filter((n) => n.type === 'JOB_CLOSED');
    expect(closed).toHaveLength(2);
    await run(s.id);
    expect((await notes(fx.workspaceId)).filter((n) => n.type === 'JOB_CLOSED')).toHaveLength(2);
    // history keeps every step
    const kinds = (
      await prisma.jobObservation.findMany({ where: { jobId: two.id }, orderBy: { id: 'asc' } })
    ).map((o) => o.kind);
    expect(kinds).toContain('MISSING');
    expect(kinds.filter((k) => k === 'STATUS_CHANGED')).toHaveLength(1);
  });

  it('close at once when the source itself reports the closure', async () => {
    const { fx, company, schedule: s } = await setup();
    provider.next = () => board([job('1'), job('2')]);
    await run(s.id);
    provider.next = () => board([job('1'), job('2', { explicitlyClosed: true })]);
    await run(s.id);
    const two = (await jobsOf(company.id)).find((j) => j.externalId === '2')!;
    expect(two).toMatchObject({
      status: 'CLOSED',
      statusReason: 'the source reported the job as closed',
    });
    expect((await notes(fx.workspaceId)).filter((n) => n.type === 'JOB_CLOSED')).toHaveLength(2);
  });

  it('are skipped when paused, and nothing is recorded as a failure', async () => {
    const { schedule: s } = await setup();
    await prisma.monitoringSchedule.update({ where: { id: s.id }, data: { enabled: false } });
    const before = provider.calls;
    expect(await run(s.id)).toMatchObject({ outcome: 'SKIPPED' });
    expect(provider.calls).toBe(before);
    expect(await schedule(s.id)).toMatchObject({ consecutiveFailures: 0, lastRunAt: null });
  });
});

describe('website checks', () => {
  it('tolerate a temporary outage: jobs stay open, one notice per persistent outage', async () => {
    const { fx, company, source, website, schedule: s } = await setup();
    provider.next = () => board([job('1')]);
    await run(s.id);
    await run(website!.id); // healthy
    expect(
      await prisma.websiteCheck.findFirstOrThrow({ where: { companyId: company.id } }),
    ).toMatchObject({
      outcome: 'OK',
      finalDomain: 'acme.example',
      changeKind: null,
    });

    site.error = new FetchError('connection timed out', 'TIMEOUT');
    for (const n of [1, 2]) {
      await run(website!.id);
      expect(await schedule(website!.id)).toMatchObject({
        consecutiveFailures: n,
        lastErrorCode: 'TIMEOUT',
      });
      expect(
        (await notes(fx.workspaceId)).filter((x) => x.type === 'WEBSITE_CHANGED'),
      ).toHaveLength(0);
    }
    // the website being down never touches the jobs or the company
    expect((await jobsOf(company.id)).map((j) => j.status)).toEqual(['OPEN']);
    expect(
      (await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).websiteStatus,
    ).toBe('VERIFIED');
    expect(
      (await prisma.jobSource.findUniqueOrThrow({ where: { id: source.id } })).consecutiveFailures,
    ).toBe(0);

    // the third failure in a row announces the outage; more failures do not repeat it
    for (let i = 0; i < 3; i++) await run(website!.id);
    const outage = (await notes(fx.workspaceId)).filter((x) => x.type === 'WEBSITE_CHANGED');
    expect(outage).toHaveLength(2); // one per member, for ONE outage
    expect(outage[0]!.body).toMatch(/Jobs are unaffected/);

    // recovery, then a brand-new outage is a new notice
    site.error = null;
    await run(website!.id);
    expect(await schedule(website!.id)).toMatchObject({
      consecutiveFailures: 0,
      lastOutcome: 'OK',
    });
    expect(
      (
        await prisma.websiteCheck.findFirstOrThrow({
          where: { companyId: company.id },
          orderBy: { id: 'desc' },
        })
      ).outcome,
    ).toBe('OK');
    site.error = new FetchError('HTTP 503', 'HTTP_ERROR', 503);
    for (let i = 0; i < 3; i++) await run(website!.id);
    expect((await notes(fx.workspaceId)).filter((x) => x.type === 'WEBSITE_CHANGED')).toHaveLength(
      4,
    );
    site.error = null;
  });

  it('notice a move to another domain, and record content changes quietly', async () => {
    const { fx, company, website } = await setup();
    await run(website!.id);
    site.body = '<html><body><h1>Acme</h1><p>We now build other things.</p></body></html>';
    await run(website!.id);
    expect(
      (
        await prisma.websiteCheck.findFirstOrThrow({
          where: { companyId: company.id },
          orderBy: { id: 'desc' },
        })
      ).changeKind,
    ).toBe('CONTENT_CHANGED');
    expect(await notes(fx.workspaceId)).toHaveLength(0);

    site.finalUrl = 'https://acme-new.example/';
    await run(website!.id);
    await run(website!.id); // the same move seen again is not news
    expect(
      (
        await prisma.websiteCheck.findFirstOrThrow({
          where: { companyId: company.id, changeKind: 'DOMAIN_CHANGED' },
        })
      ).finalDomain,
    ).toBe('acme-new.example');
    const moved = (await notes(fx.workspaceId)).filter((n) => n.type === 'WEBSITE_CHANGED');
    expect(moved).toHaveLength(2);
    expect(moved[0]!.body).toContain('acme.example');
    expect(moved[0]!.body).toContain('acme-new.example');
    site.finalUrl = null;
    site.body = '<html><body><h1>Acme</h1><p>We build things.</p></body></html>';
  });
});

describe('the scheduler', () => {
  it('claims each due schedule once, skips paused and future ones, and the check then runs', async () => {
    const { schedule: s, website } = await setup();
    const past = new Date(Date.now() - 60_000);
    await prisma.monitoringSchedule.update({ where: { id: s.id }, data: { nextRunAt: past } });
    // the website schedule is not due; another company's paused schedule is due but paused
    const paused = await setup();
    await prisma.monitoringSchedule.update({
      where: { id: paused.schedule.id },
      data: { nextRunAt: past, enabled: false },
    });
    provider.next = () => board([job('1')]);

    const [a, b] = await Promise.all([queue.tick(), queue.tick()]);
    expect(a.claimed + b.claimed).toBeGreaterThanOrEqual(1);
    const claimedIds = await prisma.monitoringSchedule.findMany({
      where: { id: { in: [s.id, website!.id, paused.schedule.id] }, lockedUntil: { not: null } },
    });
    // (the check may already have finished and released its claim)
    expect(claimedIds.map((c) => c.id)).not.toContain(paused.schedule.id);
    expect(claimedIds.map((c) => c.id)).not.toContain(website!.id);

    // the queue consumer runs it
    for (let i = 0; i < 60; i++) {
      if ((await schedule(s.id)).lastRunAt) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const done = await schedule(s.id);
    expect(done.lastRunAt).not.toBeNull();
    expect(done.lockedUntil).toBeNull();
    expect(done.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    // exactly one check, although two ticks raced for it
    expect(await prisma.jobCheck.count({ where: { scheduleId: s.id } })).toBe(1);
    expect((await schedule(paused.schedule.id)).lastRunAt).toBeNull();
  });
});

describe('notifications', () => {
  const event = (jobId: string, companyId: string): NotificationEvent => ({
    type: 'NEW_JOB',
    jobId,
    companyId,
    companyName: 'Acme',
    title: 'Backend Engineer',
    location: 'Lahore',
    applicationUrl: null,
  });

  it('are idempotent per event and recipient', async () => {
    const { fx, company } = await setup();
    const e = event(randomUUID(), company.id);
    const first = await prisma.$transaction((tx) => notifications.emit(tx, fx.workspaceId, [e]));
    expect(first).toEqual({ created: 2, duplicates: 0 });
    const again = await prisma.$transaction((tx) => notifications.emit(tx, fx.workspaceId, [e, e]));
    expect(again).toEqual({ created: 0, duplicates: 4 });
    expect(await notes(fx.workspaceId)).toHaveLength(2);
    // a different job is a different event
    await prisma.$transaction((tx) =>
      notifications.emit(tx, fx.workspaceId, [event(randomUUID(), company.id)]),
    );
    expect(await notes(fx.workspaceId)).toHaveLength(4);
  });

  it('respect preferences, and deliver to other channels exactly once', async () => {
    const { fx, other, company } = await setup();
    // one member mutes new-job alerts; the other also wants email
    await prisma.notificationPreference.create({
      data: {
        workspaceId: fx.workspaceId,
        userId: fx.userId,
        type: 'NEW_JOB',
        inApp: false,
        email: false,
      },
    });
    await prisma.notificationPreference.create({
      data: {
        workspaceId: fx.workspaceId,
        userId: other,
        type: 'NEW_JOB',
        inApp: true,
        email: true,
      },
    });
    await prisma.$transaction((tx) =>
      notifications.emit(tx, fx.workspaceId, [event(randomUUID(), company.id)]),
    );
    const rows = await notes(fx.workspaceId);
    expect(rows.map((r) => r.userId)).toEqual([other]);

    const sent: string[] = [];
    const channel: NotificationChannel = {
      id: 'email',
      configured: true,
      deliver: async (n, to) => {
        sent.push(`${n.id}:${to.userId}`);
      },
    };
    const withEmail = new NotificationService(prisma, [channel]);
    expect(await withEmail.dispatch()).toBeGreaterThanOrEqual(1);
    expect(await Promise.all([withEmail.dispatch(), withEmail.dispatch()])).toEqual([0, 0]);
    expect(sent.filter((s) => s.endsWith(`:${other}`))).toHaveLength(1);
    expect(sent.filter((s) => s.endsWith(`:${fx.userId}`))).toHaveLength(0);
    expect((await notes(fx.workspaceId))[0]!.deliveredChannels.sort()).toEqual(['email', 'in_app']);

    // an unconfigured email channel (the default) delivers nothing and breaks nothing
    expect(await notifications.dispatch()).toBe(0);
  });

  it('are scoped to the workspace that owns the event', async () => {
    const a = await setup();
    const b = await setup();
    await prisma.$transaction((tx) =>
      notifications.emit(tx, a.fx.workspaceId, [event(randomUUID(), a.company.id)]),
    );
    expect(await notes(a.fx.workspaceId)).toHaveLength(2);
    expect(await notes(b.fx.workspaceId)).toHaveLength(0);
  });
});
