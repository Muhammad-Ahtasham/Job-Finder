import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieValue, createTestApp, newCredentials, type TestContext } from './helpers';

let ctx: TestContext;
let redis: Redis;
let queue: Queue;

beforeAll(async () => {
  ctx = await createTestApp();
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  queue = new Queue('job-discovery', { connection: redis.duplicate() });
});
afterAll(async () => {
  await queue.close();
  redis.disconnect();
  await ctx.app.close();
});

interface Actor {
  cookie: string;
  userId: string;
  workspaceId: string;
}
async function newActor(): Promise<Actor> {
  const response = await request(ctx.server).post('/api/v1/auth/register').send(newCredentials());
  return {
    cookie: `jf_session=${cookieValue(response)}`,
    userId: response.body.user.id,
    workspaceId: response.body.workspaces[0].id,
  };
}
const call = (actor: Actor, method: 'get' | 'post', path: string, workspace?: string) => {
  const req = request(ctx.server)[method](`/api/v1${path}`).set('Cookie', actor.cookie);
  return workspace ? req.set('X-Workspace-Id', workspace) : req;
};
function createCompany(workspaceId: string, extra: Record<string, unknown> = {}) {
  const name = `Acme ${randomUUID().slice(0, 6)}`;
  return ctx.prisma.company.create({
    data: {
      workspaceId,
      displayName: name,
      nameKey: name.toLowerCase(),
      coreName: name.toLowerCase(),
      nameTokens: [name.toLowerCase()],
      coreTokens: [name.toLowerCase()],
      country: 'PK',
      ...extra,
    },
  });
}

describe('POST /companies/:id/jobs/refresh', () => {
  it('queues one run; repeated and simultaneous calls share it', async () => {
    const actor = await newActor();
    const company = await createCompany(actor.workspaceId);
    const first = await call(actor, 'post', `/companies/${company.id}/jobs/refresh`);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      reused: false,
      run: { companyId: company.id, status: 'QUEUED', jobsFound: 0 },
    });
    expect((await queue.getJob(`jobs-${first.body.run.id}`))?.data).toEqual({
      runId: first.body.run.id,
    });

    const burst = await Promise.all(
      Array.from({ length: 5 }, () => call(actor, 'post', `/companies/${company.id}/jobs/refresh`)),
    );
    expect(new Set(burst.map((r) => r.body.run.id))).toEqual(new Set([first.body.run.id]));
    expect(burst.every((r) => r.body.reused === true)).toBe(true);
    expect(await ctx.prisma.jobRun.count({ where: { companyId: company.id } })).toBe(1);
  });

  it('is workspace scoped, role protected, validated, and refuses merged companies', async () => {
    const [owner, outsider] = [await newActor(), await newActor()];
    const company = await createCompany(owner.workspaceId);
    expect((await call(outsider, 'post', `/companies/${company.id}/jobs/refresh`)).status).toBe(
      404,
    );
    expect((await call(owner, 'post', '/companies/nope/jobs/refresh')).status).toBe(400);
    await ctx.prisma.workspaceMember.create({
      data: { workspaceId: owner.workspaceId, userId: outsider.userId, role: 'VIEWER' },
    });
    expect(
      (await call(outsider, 'post', `/companies/${company.id}/jobs/refresh`, owner.workspaceId))
        .status,
    ).toBe(403);
    const merged = await createCompany(owner.workspaceId, {
      status: 'MERGED',
      mergedIntoId: company.id,
    });
    expect((await call(owner, 'post', `/companies/${merged.id}/jobs/refresh`)).status).toBe(409);
  });
});

describe('GET /companies/:id/jobs and /job-sources', () => {
  async function seeded() {
    const actor = await newActor();
    const company = await createCompany(actor.workspaceId);
    const mk = (providerId: string, boardKey: string, extra: Record<string, unknown> = {}) =>
      ctx.prisma.jobSource.create({
        data: {
          workspaceId: actor.workspaceId,
          companyId: company.id,
          providerId,
          boardKey,
          boardUrl: `https://x.com/${boardKey}`,
          ...extra,
        },
      });
    const good = await mk('greenhouse', 'acme', {
      lastOutcome: 'JOBS',
      lastSuccessAt: new Date(),
      lastCheckedAt: new Date(),
    });
    const broken = await mk('lever', 'acme', {
      lastOutcome: 'FAILED',
      consecutiveFailures: 2,
      lastCheckedAt: new Date(),
    });
    const unsupported = await mk('workable', 'apply.workable.com/acme', { status: 'UNSUPPORTED' });
    const job = (n: number, extra: Record<string, unknown> = {}) => ({
      workspaceId: actor.workspaceId,
      companyId: company.id,
      sourceId: good.id,
      externalId: `j-${n}`,
      fingerprint: `f-${n}`,
      title: `Role ${n}`,
      sourceUrl: `https://boards.greenhouse.io/acme/jobs/${n}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${n}?gh_src=abc`,
      extraction: 'API',
      ...extra,
    });
    await ctx.prisma.job.createMany({
      data: [
        job(1, { employmentType: 'FULL_TIME', workplaceType: 'REMOTE' }),
        job(2),
        job(3, { status: 'CLOSED', closedAt: new Date() }),
      ],
    });
    await ctx.prisma.jobCheck.create({
      data: {
        workspaceId: actor.workspaceId,
        companyId: company.id,
        sourceId: good.id,
        outcome: 'JOBS',
        authoritative: true,
        jobsFound: 2,
        finishedAt: new Date(),
      },
    });
    await ctx.prisma.jobCheck.create({
      data: {
        workspaceId: actor.workspaceId,
        companyId: company.id,
        sourceId: broken.id,
        outcome: 'FAILED',
        errorCode: 'UNAVAILABLE',
        errorMessage: 'HTTP 503',
        retryable: true,
        httpStatus: 503,
        finishedAt: new Date(),
      },
    });
    await ctx.prisma.companyPage.create({
      data: {
        companyId: company.id,
        workspaceId: actor.workspaceId,
        url: 'https://acme.com/careers',
        type: 'CAREERS',
        typeConfidence: 0.9,
        fetchStatus: 'FETCHED',
      },
    });
    return { actor, company, good, broken, unsupported };
  }

  it('lists open jobs with the original application URL, filters and paginates', async () => {
    const { actor, company } = await seeded();
    const open = await call(actor, 'get', `/companies/${company.id}/jobs`);
    expect(open.status).toBe(200);
    expect(open.body.items.map((j: { title: string }) => j.title).sort()).toEqual([
      'Role 1',
      'Role 2',
    ]);
    expect(open.body.items[0]).toMatchObject({ providerId: 'greenhouse', status: 'OPEN' });
    expect(
      open.body.items.find((j: { title: string }) => j.title === 'Role 1').applicationUrl,
    ).toBe('https://boards.greenhouse.io/acme/jobs/1?gh_src=abc');

    const closed = await call(actor, 'get', `/companies/${company.id}/jobs?status=CLOSED`);
    expect(closed.body.items.map((j: { title: string }) => j.title)).toEqual(['Role 3']);
    const remote = await call(actor, 'get', `/companies/${company.id}/jobs?workplaceType=REMOTE`);
    expect(remote.body.items).toHaveLength(1);

    const page1 = await call(actor, 'get', `/companies/${company.id}/jobs?limit=1`);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await call(
      actor,
      'get',
      `/companies/${company.id}/jobs?limit=1&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    expect(page2.body.nextCursor).toBeNull();
    expect((await call(actor, 'get', `/companies/${company.id}/jobs?status=NOPE`)).status).toBe(
      400,
    );
  });

  it('shows sources with failed vs. successful checks, unsupported platforms and career pages', async () => {
    const { actor, company } = await seeded();
    const res = await call(actor, 'get', `/companies/${company.id}/job-sources`);
    expect(res.status).toBe(200);
    expect(res.body.careerPages).toEqual([
      expect.objectContaining({ url: 'https://acme.com/careers', type: 'CAREERS' }),
    ]);
    const byProvider = Object.fromEntries(
      res.body.sources.map((s: { providerId: string }) => [s.providerId, s]),
    );
    expect(byProvider.greenhouse).toMatchObject({ lastOutcome: 'JOBS', openJobs: 2 });
    expect(byProvider.greenhouse.latestChecks[0]).toMatchObject({
      outcome: 'JOBS',
      authoritative: true,
    });
    expect(byProvider.lever).toMatchObject({
      lastOutcome: 'FAILED',
      consecutiveFailures: 2,
      openJobs: 0,
    });
    expect(byProvider.lever.latestChecks[0]).toMatchObject({
      outcome: 'FAILED',
      errorCode: 'UNAVAILABLE',
      retryable: true,
      httpStatus: 503,
    });
    expect(byProvider.workable).toMatchObject({ status: 'UNSUPPORTED', latestChecks: [] });
    expect(res.body.vacancyKnowledge).toBe('KNOWN');
  });

  it('vacancyKnowledge is UNKNOWN until some source has actually answered', async () => {
    const actor = await newActor();
    const company = await createCompany(actor.workspaceId);
    expect((await call(actor, 'get', `/companies/${company.id}/job-sources`)).body).toMatchObject({
      sources: [],
      vacancyKnowledge: 'UNKNOWN',
    });
    await ctx.prisma.jobSource.create({
      data: {
        workspaceId: actor.workspaceId,
        companyId: company.id,
        providerId: 'lever',
        boardKey: 'x',
        boardUrl: 'https://x.com',
        lastOutcome: 'FAILED',
      },
    });
    expect(
      (await call(actor, 'get', `/companies/${company.id}/job-sources`)).body.vacancyKnowledge,
    ).toBe('UNKNOWN');
    expect((await call(actor, 'get', `/companies/${company.id}/jobs`)).body.items).toEqual([]); // empty ≠ no vacancies
  });

  it('does not leak across workspaces; viewers may read', async () => {
    const { actor, company } = await seeded();
    const outsider = await newActor();
    expect((await call(outsider, 'get', `/companies/${company.id}/jobs`)).status).toBe(404);
    expect((await call(outsider, 'get', `/companies/${company.id}/job-sources`)).status).toBe(404);
    await ctx.prisma.workspaceMember.create({
      data: { workspaceId: actor.workspaceId, userId: outsider.userId, role: 'VIEWER' },
    });
    expect(
      (await call(outsider, 'get', `/companies/${company.id}/jobs`, actor.workspaceId)).status,
    ).toBe(200);
  });

  it('documents the endpoints', async () => {
    const json = await request(ctx.server).get('/docs/json');
    expect(Object.keys(json.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/companies/{id}/jobs/refresh',
        '/api/v1/companies/{id}/jobs',
        '/api/v1/companies/{id}/job-sources',
      ]),
    );
  });
});
