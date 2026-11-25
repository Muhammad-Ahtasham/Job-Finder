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
  queue = new Queue('job-matching', { connection: redis.duplicate() });
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
const call = (actor: Actor, method: 'get' | 'post' | 'put', path: string) =>
  request(ctx.server)[method](`/api/v1${path}`).set('Cookie', actor.cookie);

/** A company, a source, two jobs (one analysed, with skills) and a project that found the company. */
async function seed(actor: Actor) {
  const name = `Acme ${randomUUID().slice(0, 6)}`;
  const company = await ctx.prisma.company.create({
    data: {
      workspaceId: actor.workspaceId,
      displayName: name,
      nameKey: name.toLowerCase(),
      coreName: name.toLowerCase(),
      nameTokens: [name.toLowerCase()],
      coreTokens: [name.toLowerCase()],
      country: 'PK',
    },
  });
  const source = await ctx.prisma.jobSource.create({
    data: {
      workspaceId: actor.workspaceId,
      companyId: company.id,
      providerId: 'greenhouse',
      boardKey: 'acme',
      boardUrl: 'https://boards.greenhouse.io/acme',
    },
  });
  const mk = (externalId: string, title: string, extra: Record<string, unknown> = {}) =>
    ctx.prisma.job.create({
      data: {
        workspaceId: actor.workspaceId,
        companyId: company.id,
        sourceId: source.id,
        externalId,
        fingerprint: externalId,
        title,
        sourceUrl: `https://boards.greenhouse.io/acme/jobs/${externalId}`,
        extraction: 'API',
        ...extra,
      },
    });
  const analysed = await mk('1', 'Senior Backend Developer', {
    normalizedTitle: 'Backend Developer',
    seniority: 'SENIOR',
    roleCategory: 'SOFTWARE_ENGINEERING',
    analysisHash: 'h',
    analyzedAt: new Date(),
    analysisProvider: 'rules',
    analysisModel: 'rules',
    analysisPromptVersion: 'rules/v1',
    analysisConfidence: 0.8,
    salaryMin: 250000,
    salaryMax: 350000,
    salaryCurrency: 'PKR',
    salaryPeriod: 'MONTH',
    salaryText: 'PKR 250,000 - 350,000 per month',
    skills: {
      create: [
        { skillKey: 'nodejs', name: 'Node.js', kind: 'REQUIRED', source: 'RULES' },
        { skillKey: 'docker', name: 'Docker', kind: 'PREFERRED', source: 'RULES' },
      ],
    },
    requirements: {
      create: [
        { kind: 'EXPERIENCE', text: '3-5 years', minYears: 3, maxYears: 5, source: 'RULES' },
      ],
    },
  });
  const closed = await mk('2', 'Designer', { status: 'CLOSED' });
  await ctx.prisma.jobObservation.createMany({
    data: [
      { workspaceId: actor.workspaceId, jobId: analysed.id, kind: 'FIRST_SEEN', toStatus: 'OPEN' },
      { workspaceId: actor.workspaceId, jobId: analysed.id, kind: 'SEEN' },
      { workspaceId: actor.workspaceId, jobId: analysed.id, kind: 'ANALYZED' },
    ],
  });

  const project = await ctx.prisma.searchProject.create({
    data: {
      workspaceId: actor.workspaceId,
      name: `p-${randomUUID()}`,
      city: 'Lahore',
      industry: 'software',
      keywords: ['software'],
    },
  });
  return { company, source, analysed, closed, project };
}

describe('GET /jobs, /jobs/:id, /jobs/:id/history', () => {
  it('lists structured jobs with filters, and is workspace scoped', async () => {
    const actor = await newActor();
    const outsider = await newActor();
    const { analysed, closed } = await seed(actor);

    const all = await call(actor, 'get', '/jobs');
    expect(all.status).toBe(200);
    expect(all.body.items.map((j: { id: string }) => j.id).sort()).toEqual(
      [analysed.id, closed.id].sort(),
    );

    const open = await call(
      actor,
      'get',
      '/jobs?status=OPEN&skill=node.js&seniority=SENIOR&q=backend',
    );
    expect(open.body.items).toHaveLength(1);
    expect(open.body.items[0]).toMatchObject({
      id: analysed.id,
      normalizedTitle: 'Backend Developer',
      seniority: 'SENIOR',
      salary: { min: 250000, max: 350000, currency: 'PKR', period: 'MONTH' },
      minYearsExperience: null,
      analysis: { state: 'ANALYZED', provider: 'rules' },
      skills: [
        { key: 'nodejs', kind: 'REQUIRED' },
        { key: 'docker', kind: 'PREFERRED' },
      ].map((s) => expect.objectContaining(s)),
    });
    expect((await call(actor, 'get', '/jobs?skill=kafka')).body.items).toEqual([]);
    expect((await call(actor, 'get', '/jobs?status=CLOSED')).body.items).toHaveLength(1);
    expect((await call(actor, 'get', '/jobs?status=BOGUS')).status).toBe(400);

    expect((await call(outsider, 'get', '/jobs')).body.items).toEqual([]);
    expect((await call(outsider, 'get', `/jobs/${analysed.id}`)).status).toBe(404);
    expect((await call(outsider, 'get', `/jobs/${analysed.id}/history`)).status).toBe(404);
  });

  it('returns one job with requirements, and its history newest first', async () => {
    const actor = await newActor();
    const { analysed } = await seed(actor);
    const one = await call(actor, 'get', `/jobs/${analysed.id}`);
    expect(one.status).toBe(200);
    expect(one.body.requirements).toEqual([
      expect.objectContaining({ kind: 'EXPERIENCE', minYears: 3, maxYears: 5, text: '3-5 years' }),
    ]);

    const history = await call(actor, 'get', `/jobs/${analysed.id}/history?limit=2`);
    expect(history.status).toBe(200);
    expect(history.body.items.map((o: { kind: string }) => o.kind)).toEqual(['ANALYZED', 'SEEN']);
    expect(history.body.nextCursor).not.toBeNull();
    const rest = await call(
      actor,
      'get',
      `/jobs/${analysed.id}/history?limit=2&cursor=${history.body.nextCursor}`,
    );
    expect(rest.body.items.map((o: { kind: string }) => o.kind)).toEqual(['FIRST_SEEN']);
    expect(rest.body.nextCursor).toBeNull();
  });
});

describe('project matches and matching preferences', () => {
  it('serves matches best first with explanation and evidence, filtered by minScore and status', async () => {
    const actor = await newActor();
    const { analysed, project } = await seed(actor);
    const hi = await ctx.prisma.jobMatch.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId: project.id,
        jobId: analysed.id,
        score: 86.5,
        roleScore: 1,
        skillsScore: 0.8,
        experienceScore: null,
        locationScore: 1,
        matchedSkills: ['Node.js'],
        missingSkills: ['Docker'],
        experienceFit: 'UNKNOWN',
        locationFit: 'MATCH',
        explanation: 'Close fit.',
        explanationSource: 'RULES',
        confidence: 0.7,
        provider: 'rules',
        model: 'rules',
        promptVersion: 'rules/v1',
        weights: { role: 0.3, skills: 0.4, experience: 0.2, location: 0.1 },
        inputHash: 'x',
        evidence: {
          create: [{ kind: 'SKILL_MISSING', label: 'Docker', detail: 'Preferred', position: 0 }],
        },
      },
    });

    const res = await call(actor, 'get', `/projects/${project.id}/matches`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: hi.id,
      score: 86.5,
      components: { role: 1, skills: 0.8, experience: null, location: 1 },
      matchedSkills: ['Node.js'],
      missingSkills: ['Docker'],
      explanation: 'Close fit.',
      confidence: 0.7,
      provider: 'rules',
      promptVersion: 'rules/v1',
      evidence: [{ kind: 'SKILL_MISSING', label: 'Docker' }],
      job: { id: analysed.id },
    });
    expect(
      (await call(actor, 'get', `/projects/${project.id}/matches?minScore=90`)).body.items,
    ).toEqual([]);
    expect(
      (await call(actor, 'get', `/projects/${project.id}/matches?status=CLOSED`)).body.items,
    ).toEqual([]);
    expect(
      (await call(actor, 'get', `/projects/${project.id}/matches?cursor=garbage`)).status,
    ).toBe(400);
    expect((await call(await newActor(), 'get', `/projects/${project.id}/matches`)).status).toBe(
      404,
    );
  });

  it('reads defaults, updates preferences (partial), validates, versions and queues a re-match', async () => {
    const actor = await newActor();
    const { project } = await seed(actor);
    const defaults = await call(actor, 'get', `/projects/${project.id}/matching-preferences`);
    expect(defaults.body).toMatchObject({
      weights: { role: 0.3, skills: 0.4, experience: 0.2, location: 0.1 },
      yearsExperience: null,
      version: 0,
    });

    const put = await call(actor, 'put', `/projects/${project.id}/matching-preferences`).send({
      weights: { skills: 0.6 },
      yearsExperience: 4,
      workplaceTypes: ['REMOTE'],
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      weights: { role: 0.3, skills: 0.6, experience: 0.2, location: 0.1 },
      yearsExperience: 4,
      workplaceTypes: ['REMOTE'],
      version: 1,
    });
    const second = await call(actor, 'put', `/projects/${project.id}/matching-preferences`).send({
      minScore: 50,
    });
    expect(second.body).toMatchObject({
      minScore: 50,
      version: 2,
      yearsExperience: 4,
      weights: { skills: 0.6 },
    });
    expect((await queue.getJob(`match-${project.id}`))?.data).toEqual({ projectId: project.id });

    for (const bad of [
      {},
      { weights: { role: 2 } },
      { weights: { role: 0, skills: 0, experience: 0, location: 0 } },
      { seniorities: ['WIZARD'] },
      { unknown: 1 },
    ]) {
      expect(
        (await call(actor, 'put', `/projects/${project.id}/matching-preferences`).send(bad)).status,
      ).toBe(400);
    }
    expect(
      (
        await call(await newActor(), 'put', `/projects/${project.id}/matching-preferences`).send({
          minScore: 1,
        })
      ).status,
    ).toBe(404);

    const refresh = await call(actor, 'post', `/projects/${project.id}/matches/refresh`);
    expect(refresh.status).toBe(202);
    expect(refresh.body).toEqual({ queued: true });
  });
});
