import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieValue, createTestApp, newCredentials, type TestContext } from './helpers';

let ctx: TestContext;
let redis: Redis;
let planQueue: Queue;

beforeAll(async () => {
  ctx = await createTestApp();
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  planQueue = new Queue('discovery-runs', { connection: redis.duplicate() });
});
afterAll(async () => {
  await planQueue.close();
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

const call = (
  actor: Actor,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  workspace?: string,
) => {
  const req = request(ctx.server)[method](`/api/v1${path}`).set('Cookie', actor.cookie);
  return workspace ? req.set('X-Workspace-Id', workspace) : req;
};

const lahore = (name = `Lahore Software Houses ${randomUUID().slice(0, 6)}`) => ({
  name,
  country: 'PK',
  city: 'Lahore',
  industry: 'Software Development',
  keywords: [
    'Software House',
    'IT Company',
    'Software Development Company',
    'SaaS Company',
    'Technology Company',
  ],
  targetRoles: ['Software Engineer', 'Backend Developer'],
  targetSkills: ['TypeScript', 'PostgreSQL'],
});

async function createProject(actor: Actor, body: object = lahore()) {
  const response = await call(actor, 'post', '/projects').send(body);
  expect(response.status).toBe(201);
  return response.body as { id: string };
}

describe('projects', () => {
  it('creates the example project with all fields', async () => {
    const actor = await newActor();
    const body = lahore('Lahore Software Houses');
    const response = await call(actor, 'post', '/projects').send(body);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      name: 'Lahore Software Houses',
      country: 'PK',
      city: 'Lahore',
      industry: 'Software Development',
      keywords: body.keywords,
      targetRoles: ['Software Engineer', 'Backend Developer'],
      targetSkills: ['TypeScript', 'PostgreSQL'],
      lastRun: null,
    });
    const row = await ctx.prisma.searchProject.findUniqueOrThrow({
      where: { id: response.body.id },
    });
    expect(row.workspaceId).toBe(actor.workspaceId);
    expect(row.createdById).toBe(actor.userId);
  });

  it('defaults the country to Pakistan and roles/skills to empty', async () => {
    const actor = await newActor();
    const response = await call(actor, 'post', '/projects').send({
      name: 'Defaults',
      city: 'Karachi',
      industry: 'Software',
      keywords: ['IT Company'],
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ country: 'PK', targetRoles: [], targetSkills: [] });
  });

  it('normalizes lists: trims, drops case-insensitive duplicates, uppercases country', async () => {
    const actor = await newActor();
    const response = await call(actor, 'post', '/projects').send({
      name: 'Norm',
      country: 'pk',
      city: ' Lahore ',
      industry: 'Software',
      keywords: [' IT Company ', 'it company', 'SaaS Company'],
    });
    expect(response.status).toBe(201);
    expect(response.body.country).toBe('PK');
    expect(response.body.city).toBe('Lahore');
    expect(response.body.keywords).toEqual(['IT Company', 'SaaS Company']);
  });

  it('validates input', async () => {
    const actor = await newActor();
    const bad = async (patch: object, expectedStatus = 400) => {
      const response = await call(actor, 'post', '/projects').send({ ...lahore(), ...patch });
      expect(response.status, JSON.stringify(patch)).toBe(expectedStatus);
    };
    await bad({ keywords: [] });
    await bad({ keywords: ['ok', ''] });
    await bad({ name: '' });
    await bad({ city: '' });
    await bad({ country: 'PAK' });
    await bad({ country: 'ZZ' }); // well-formed but not a real country
    await bad({ keywords: Array.from({ length: 21 }, (_, i) => `kw${i}`) });
    await bad({ workspaceId: randomUUID() }); // unknown/forbidden field
  });

  it('rejects a duplicate name within the workspace but allows it in another', async () => {
    const [a, b] = [await newActor(), await newActor()];
    await createProject(a, lahore('Same Name'));
    expect((await call(a, 'post', '/projects').send(lahore('Same Name'))).status).toBe(409);
    expect((await call(b, 'post', '/projects').send(lahore('Same Name'))).status).toBe(201);
  });

  it('lists, gets and updates (PATCH changes only the given fields)', async () => {
    const actor = await newActor();
    const project = await createProject(actor, { ...lahore('Patchable'), country: 'PK' });

    const list = await call(actor, 'get', '/projects');
    expect(list.status).toBe(200);
    expect(list.body.items.map((p: { id: string }) => p.id)).toContain(project.id);

    const patched = await call(actor, 'patch', `/projects/${project.id}`).send({
      city: 'Islamabad',
      targetSkills: ['Go'],
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      city: 'Islamabad',
      targetSkills: ['Go'],
      country: 'PK', // untouched, not reset to a default
      industry: 'Software Development',
      keywords: lahore().keywords,
      targetRoles: ['Software Engineer', 'Backend Developer'],
    });
    expect((await call(actor, 'get', `/projects/${project.id}`)).body.city).toBe('Islamabad');

    expect((await call(actor, 'patch', `/projects/${project.id}`).send({})).status).toBe(400);
    expect(
      (await call(actor, 'patch', `/projects/${project.id}`).send({ keywords: [] })).status,
    ).toBe(400);
    expect(
      (await call(actor, 'patch', `/projects/${project.id}`).send({ country: 'ZZ' })).status,
    ).toBe(400);
  });

  it('deletes a project with its runs, but keeps discovered companies', async () => {
    const actor = await newActor();
    const project = await createProject(actor);
    const run = (await call(actor, 'post', `/projects/${project.id}/runs`)).body;
    await call(actor, 'post', `/runs/${run.id}/cancel`);
    const company = await ctx.prisma.company.create({
      data: {
        workspaceId: actor.workspaceId,
        displayName: 'Kept',
        nameKey: 'kept',
        coreName: 'kept',
        nameTokens: ['kept'],
        coreTokens: ['kept'],
        country: 'PK',
      },
    });

    expect((await call(actor, 'delete', `/projects/${project.id}`)).status).toBe(204);
    expect((await call(actor, 'get', `/projects/${project.id}`)).status).toBe(404);
    expect(await ctx.prisma.searchRun.count({ where: { projectId: project.id } })).toBe(0);
    expect(await ctx.prisma.company.findUnique({ where: { id: company.id } })).not.toBeNull();
  });

  it('refuses to delete a project while a run is active', async () => {
    const actor = await newActor();
    const project = await createProject(actor);
    await call(actor, 'post', `/projects/${project.id}/runs`);
    expect((await call(actor, 'delete', `/projects/${project.id}`)).status).toBe(409);
  });

  it('returns 400 for malformed ids and 404 for unknown ones', async () => {
    const actor = await newActor();
    expect((await call(actor, 'get', '/projects/not-a-uuid')).status).toBe(400);
    expect((await call(actor, 'get', `/projects/${randomUUID()}`)).status).toBe(404);
  });
});

describe('runs', () => {
  it('starts a run, snapshots config, and enqueues exactly one plan job', async () => {
    const actor = await newActor();
    const project = await createProject(actor);

    const response = await call(actor, 'post', `/projects/${project.id}/runs`);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      projectId: project.id,
      status: 'QUEUED',
      cancelRequested: false,
      stats: { candidatesFound: 0 },
    });

    const row = await ctx.prisma.searchRun.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(row.workspaceId).toBe(actor.workspaceId);
    expect(row.config).toMatchObject({
      city: 'Lahore',
      country: 'PK',
      keywords: lahore().keywords,
    });

    const job = await planQueue.getJob(`plan-${response.body.id}`);
    expect(job?.data).toEqual({ runId: response.body.id });

    // Editing the project afterwards does not alter the run's snapshot.
    await call(actor, 'patch', `/projects/${project.id}`).send({ city: 'Multan' });
    expect(
      (await ctx.prisma.searchRun.findUniqueOrThrow({ where: { id: row.id } })).config,
    ).toMatchObject({ city: 'Lahore' });
  });

  it('allows only one active run per project and honours Idempotency-Key', async () => {
    const actor = await newActor();
    const project = await createProject(actor);
    const key = `key-${randomUUID()}`;

    const first = await call(actor, 'post', `/projects/${project.id}/runs`).set(
      'Idempotency-Key',
      key,
    );
    const replay = await call(actor, 'post', `/projects/${project.id}/runs`).set(
      'Idempotency-Key',
      key,
    );
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body.id).toBe(first.body.id);

    expect((await call(actor, 'post', `/projects/${project.id}/runs`)).status).toBe(409);
    expect(await ctx.prisma.searchRun.count({ where: { projectId: project.id } })).toBe(1);

    expect(
      (await call(actor, 'post', `/projects/${project.id}/runs`).set('Idempotency-Key', 'bad key!'))
        .status,
    ).toBe(400);
  });

  it('concurrent starts create a single run', async () => {
    const actor = await newActor();
    const project = await createProject(actor);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => call(actor, 'post', `/projects/${project.id}/runs`)),
    );
    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await ctx.prisma.searchRun.count({ where: { projectId: project.id } })).toBe(1);
  });

  it('lists a project’s runs and exposes the latest on the project', async () => {
    const actor = await newActor();
    const project = await createProject(actor);
    const run = (await call(actor, 'post', `/projects/${project.id}/runs`)).body;

    const runs = await call(actor, 'get', `/projects/${project.id}/runs`);
    expect(runs.body.items.map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect((await call(actor, 'get', `/runs/${run.id}`)).body.id).toBe(run.id);
    expect((await call(actor, 'get', `/projects/${project.id}`)).body.lastRun.id).toBe(run.id);
  });

  it('reports progress from persisted tasks, providers and errors', async () => {
    const actor = await newActor();
    const project = await createProject(actor);
    const run = (await call(actor, 'post', `/projects/${project.id}/runs`)).body;

    const fresh = await call(actor, 'get', `/runs/${run.id}/progress`);
    expect(fresh.body).toMatchObject({
      status: 'QUEUED',
      planned: false,
      percent: 0,
      tasks: { total: 0 },
      providers: [],
      error: null,
    });

    await ctx.prisma.searchRun.update({
      where: { id: run.id },
      data: {
        status: 'RUNNING',
        plannedAt: new Date(),
        candidatesFound: 7,
        companiesCreated: 5,
        companiesMatched: 2,
        config: {
          country: 'PK',
          city: 'Lahore',
          industry: 'Software Development',
          keywords: ['a'],
          providers: [
            {
              id: 'overpass-osm',
              displayName: 'OpenStreetMap (Overpass)',
              attribution: '© OpenStreetMap contributors (ODbL 1.0)',
            },
            { id: 'brave-search', displayName: 'Brave Search API', attribution: null },
          ],
          skippedProviders: [{ id: 'other', reason: 'not licensed' }],
        },
      },
    });
    const mk = (
      providerId: string,
      key: string,
      status: 'SUCCEEDED' | 'FAILED' | 'RETRYING' | 'QUEUED',
      extra: object = {},
    ) =>
      ctx.prisma.discoveryTask.create({
        data: {
          runId: run.id,
          providerId,
          queryKey: key,
          kind: 'KEYWORD',
          keyword: key,
          status,
          ...extra,
        },
      });
    await mk('overpass-osm', 'a', 'SUCCEEDED', { candidatesFound: 4 });
    await mk('overpass-osm', 'b', 'SUCCEEDED', { candidatesFound: 3 });
    await mk('brave-search', 'a', 'FAILED', {
      attempts: 3,
      lastErrorCode: 'AUTH',
      lastErrorMessage: 'bad key',
      lastErrorRetryable: false,
      lastErrorAt: new Date(),
    });
    await mk('brave-search', 'b', 'RETRYING', {
      attempts: 1,
      lastErrorCode: 'UNAVAILABLE',
      lastErrorMessage: 'HTTP 503',
      lastErrorRetryable: true,
      lastErrorAt: new Date(),
    });
    await mk('brave-search', 'c', 'QUEUED');

    const { body } = await call(actor, 'get', `/runs/${run.id}/progress`);
    expect(body).toMatchObject({
      status: 'RUNNING',
      planned: true,
      percent: 60, // 3 of 5 tasks terminal
      stats: { candidatesFound: 7, companiesCreated: 5, companiesMatched: 2 },
      tasks: {
        total: 5,
        succeeded: 2,
        failed: 1,
        retrying: 1,
        queued: 1,
        running: 0,
        cancelled: 0,
      },
      skippedProviders: [{ id: 'other', reason: 'not licensed' }],
    });
    const osm = body.providers.find((p: { providerId: string }) => p.providerId === 'overpass-osm');
    const brave = body.providers.find(
      (p: { providerId: string }) => p.providerId === 'brave-search',
    );
    expect(osm).toMatchObject({
      displayName: 'OpenStreetMap (Overpass)',
      attribution: '© OpenStreetMap contributors (ODbL 1.0)',
      candidatesFound: 7,
      errors: [],
    });
    expect(brave.tasks).toMatchObject({ total: 3, failed: 1, retrying: 1, queued: 1 });
    expect(brave.errors.map((e: { code: string }) => e.code).sort()).toEqual([
      'AUTH',
      'UNAVAILABLE',
    ]);
    expect(brave.errors.find((e: { code: string }) => e.code === 'AUTH')).toMatchObject({
      retryable: false,
      attempts: 3,
    });
  });

  it('cancels a queued run immediately, and a finished run cannot be cancelled again', async () => {
    const actor = await newActor();
    const project = await createProject(actor);
    const run = (await call(actor, 'post', `/projects/${project.id}/runs`)).body;

    const cancelled = await call(actor, 'post', `/runs/${run.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelRequested: true });
    expect(cancelled.body.finishedAt).not.toBeNull();
    expect((await call(actor, 'post', `/runs/${run.id}/cancel`)).status).toBe(409);

    // Cancelling frees the project for a new run.
    expect((await call(actor, 'post', `/projects/${project.id}/runs`)).status).toBe(202);
  });

  it('cancelling a running run cancels queued tasks and lets running ones drain', async () => {
    const actor = await newActor();
    const project = await createProject(actor);
    const run = (await call(actor, 'post', `/projects/${project.id}/runs`)).body;
    await ctx.prisma.searchRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', plannedAt: new Date() },
    });
    const mk = (key: string, status: 'QUEUED' | 'RUNNING' | 'RETRYING') =>
      ctx.prisma.discoveryTask.create({
        data: {
          runId: run.id,
          providerId: 'p',
          queryKey: key,
          kind: 'KEYWORD',
          keyword: key,
          status,
        },
      });
    await mk('q', 'QUEUED');
    await mk('r', 'RETRYING');
    await mk('x', 'RUNNING');

    const response = await call(actor, 'post', `/runs/${run.id}/cancel`);
    expect(response.status).toBe(200);
    // A task is still executing, so the worker finalizes; the request is recorded.
    expect(response.body).toMatchObject({
      status: 'RUNNING',
      cancelRequested: true,
      tasks: { cancelled: 2, running: 1 },
    });
  });
});

describe('workspace isolation and roles', () => {
  it('hides every resource of another workspace (404) and never lists it', async () => {
    const [owner, other] = [await newActor(), await newActor()];
    const project = await createProject(owner);
    const run = (await call(owner, 'post', `/projects/${project.id}/runs`)).body;

    for (const [method, path] of [
      ['get', `/projects/${project.id}`],
      ['patch', `/projects/${project.id}`],
      ['delete', `/projects/${project.id}`],
      ['post', `/projects/${project.id}/runs`],
      ['get', `/projects/${project.id}/runs`],
      ['get', `/runs/${run.id}`],
      ['get', `/runs/${run.id}/progress`],
      ['get', `/runs/${run.id}/results`],
      ['post', `/runs/${run.id}/cancel`],
    ] as const) {
      const response = await call(other, method, path).send(
        method === 'patch' ? { city: 'X' } : undefined,
      );
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect((await call(other, 'get', '/projects')).body.items).toEqual([]);
    // …and the owner's data is untouched by those attempts.
    expect((await call(owner, 'get', `/runs/${run.id}`)).body.status).toBe('QUEUED');
    expect((await call(owner, 'get', `/projects/${project.id}`)).body.city).toBe('Lahore');
  });

  it('rejects an X-Workspace-Id the caller does not belong to', async () => {
    const [owner, other] = [await newActor(), await newActor()];
    expect((await call(other, 'get', '/projects', owner.workspaceId)).status).toBe(403);
    expect((await call(other, 'get', '/projects', 'nope')).status).toBe(400);
  });

  it('enforces workspace roles', async () => {
    const [owner, member] = [await newActor(), await newActor()];
    const project = await createProject(owner);
    const membership = (role: 'VIEWER' | 'MEMBER' | 'ADMIN') =>
      ctx.prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: owner.workspaceId, userId: member.userId } },
        create: { workspaceId: owner.workspaceId, userId: member.userId, role },
        update: { role },
      });
    const asMember = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
      call(member, method, path, owner.workspaceId);

    await membership('VIEWER');
    expect((await asMember('get', '/projects')).status).toBe(200);
    expect((await asMember('get', `/projects/${project.id}`)).status).toBe(200);
    expect((await asMember('post', '/projects').send(lahore())).status).toBe(403);
    expect((await asMember('post', `/projects/${project.id}/runs`)).status).toBe(403);
    expect((await asMember('patch', `/projects/${project.id}`).send({ city: 'X' })).status).toBe(
      403,
    );

    await membership('MEMBER');
    expect((await asMember('post', '/projects').send(lahore())).status).toBe(201);
    expect((await asMember('post', `/projects/${project.id}/runs`)).status).toBe(202);
    expect((await asMember('delete', `/projects/${project.id}`)).status).toBe(403); // needs ADMIN

    await membership('ADMIN');
    const run = await ctx.prisma.searchRun.findFirstOrThrow({ where: { projectId: project.id } });
    await asMember('post', `/runs/${run.id}/cancel`);
    expect((await asMember('delete', `/projects/${project.id}`)).status).toBe(204);
  });

  it('requires authentication', async () => {
    expect((await request(ctx.server).get('/api/v1/projects')).status).toBe(401);
    expect((await request(ctx.server).post('/api/v1/projects').send(lahore())).status).toBe(401);
  });
});

describe('results, companies and reviews', () => {
  async function seedCompany(workspaceId: string, name: string, extra: object = {}) {
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

  it('lists a run’s results with pagination and company detail with provenance', async () => {
    const actor = await newActor();
    const project = await createProject(actor);
    const run = (await call(actor, 'post', `/projects/${project.id}/runs`)).body;
    const companies = [];
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const company = await seedCompany(
        actor.workspaceId,
        name,
        name === 'Alpha' ? { website: 'https://alpha.pk', websiteStatus: 'UNVERIFIED' } : {},
      );
      const source = await ctx.prisma.companySource.create({
        data: {
          companyId: company.id,
          workspaceId: actor.workspaceId,
          providerId: 'overpass-osm',
          sourceKey: `ext:${name}`,
          rawName: name,
          attribution: '© OSM',
          sourceUrl: `https://osm.test/${name}`,
          retrievedAt: new Date(),
        },
      });
      await ctx.prisma.discoveryResult.create({
        data: {
          runId: run.id,
          workspaceId: actor.workspaceId,
          companyId: company.id,
          companySourceId: source.id,
          providerId: 'overpass-osm',
          sourceKey: `ext:${name}`,
          outcome: 'CREATED',
          keywords: ['IT Company'],
        },
      });
      companies.push(company);
    }

    const first = await call(actor, 'get', `/runs/${run.id}/results?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await call(
      actor,
      'get',
      `/runs/${run.id}/results?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const names = [...first.body.items, ...second.body.items]
      .map((i: { company: { displayName: string } }) => i.company.displayName)
      .sort();
    expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);

    // Incomplete companies are visible with explicit MISSING statuses.
    const beta = [...first.body.items, ...second.body.items].find(
      (i) => i.company.displayName === 'Beta',
    ).company;
    expect(beta).toMatchObject({
      website: null,
      websiteStatus: 'MISSING',
      emailStatus: 'MISSING',
      careersStatus: 'MISSING',
    });

    const detail = await call(actor, 'get', `/companies/${companies[0]!.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.sources[0]).toMatchObject({
      providerId: 'overpass-osm',
      attribution: '© OSM',
      sourceUrl: 'https://osm.test/Alpha',
    });

    const listed = await call(actor, 'get', '/companies?q=alph');
    expect(listed.body.items.map((c: { displayName: string }) => c.displayName)).toEqual(['Alpha']);

    // Another workspace can neither list nor open them.
    const other = await newActor();
    expect((await call(other, 'get', `/companies/${companies[0]!.id}`)).status).toBe(404);
    expect((await call(other, 'get', '/companies')).body.items).toEqual([]);
  });

  async function seedReviewPair(actor: Actor) {
    const existing = await seedCompany(actor.workspaceId, 'Netsol', { city: 'Lahore' });
    const candidate = await seedCompany(actor.workspaceId, 'Netsol Technologies', {
      website: 'https://netsol.pk',
      domain: 'netsol.pk',
      websiteStatus: 'UNVERIFIED',
      description: 'Enterprise software',
    });
    await ctx.prisma.companyIdentity.create({
      data: {
        companyId: candidate.id,
        workspaceId: actor.workspaceId,
        type: 'DOMAIN',
        scope: '',
        value: 'netsol.pk',
      },
    });
    const source = await ctx.prisma.companySource.create({
      data: {
        companyId: candidate.id,
        workspaceId: actor.workspaceId,
        providerId: 'brave-search',
        sourceKey: 'web:netsol.pk',
        rawName: 'Netsol Technologies',
        retrievedAt: new Date(),
      },
    });
    await ctx.prisma.companyLocation.create({
      data: {
        companyId: candidate.id,
        locationKey: 'k1',
        country: 'PK',
        city: 'Lahore',
        cityKey: 'lahore',
      },
    });
    const review = await ctx.prisma.matchReview.create({
      data: {
        workspaceId: actor.workspaceId,
        candidateCompanyId: candidate.id,
        existingCompanyId: existing.id,
        pairKey: [candidate.id, existing.id].sort().join(':'),
        score: 0.85,
        reasons: ['same name and city', 'no corroborating address/phone'],
      },
    });
    return { existing, candidate, review, source };
  }

  it('lists pending reviews and merges the candidate into the existing company', async () => {
    const actor = await newActor();
    const { existing, candidate, review, source } = await seedReviewPair(actor);

    const list = await call(actor, 'get', '/reviews');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: review.id, status: 'PENDING', score: 0.85 });
    expect(list.body.items[0].candidate.id).toBe(candidate.id);
    expect(list.body.items[0].existing.id).toBe(existing.id);

    const merged = await call(actor, 'post', `/reviews/${review.id}/merge`);
    expect(merged.status).toBe(200);
    expect(merged.body.id).toBe(existing.id);
    // survivor keeps its own values and gains the gaps + provenance + aliases
    expect(merged.body).toMatchObject({
      city: 'Lahore',
      website: 'https://netsol.pk',
      description: 'Enterprise software',
      websiteStatus: 'UNVERIFIED',
    });
    expect(merged.body.aliases).toContain('Netsol Technologies');
    expect(merged.body.sources.map((s: { providerId: string }) => s.providerId)).toEqual([
      'brave-search',
    ]);
    expect(merged.body.identities).toEqual([{ type: 'DOMAIN', scope: '', value: 'netsol.pk' }]);
    expect(merged.body.locations).toHaveLength(1);

    const loser = await ctx.prisma.company.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(loser).toMatchObject({ status: 'MERGED', mergedIntoId: existing.id });
    expect(
      (await ctx.prisma.companySource.findUniqueOrThrow({ where: { id: source.id } })).companyId,
    ).toBe(existing.id);
    expect(
      (await call(actor, 'get', '/companies')).body.items.map((c: { id: string }) => c.id),
    ).toEqual([existing.id]);

    expect(
      (await ctx.prisma.matchReview.findUniqueOrThrow({ where: { id: review.id } })).status,
    ).toBe('MERGED');
    expect((await call(actor, 'post', `/reviews/${review.id}/merge`)).status).toBe(409);
    expect((await call(actor, 'post', `/reviews/${review.id}/dismiss`)).status).toBe(409);
  });

  it('dismissing keeps both companies and the decision sticks', async () => {
    const actor = await newActor();
    const { existing, candidate, review } = await seedReviewPair(actor);

    const dismissed = await call(actor, 'post', `/reviews/${review.id}/dismiss`);
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe('DISMISSED');
    expect(
      (await ctx.prisma.company.findUniqueOrThrow({ where: { id: candidate.id } })).status,
    ).toBe('ACTIVE');
    expect(
      (await ctx.prisma.company.findUniqueOrThrow({ where: { id: existing.id } })).status,
    ).toBe('ACTIVE');
    expect((await call(actor, 'get', '/reviews')).body.items).toEqual([]);
    expect((await call(actor, 'get', '/reviews?status=DISMISSED')).body.items).toHaveLength(1);
  });

  it('re-points other pending reviews at the survivor when a company is merged away', async () => {
    const actor = await newActor();
    const { existing, candidate, review } = await seedReviewPair(actor);
    const third = await seedCompany(actor.workspaceId, 'Netsol Group');
    const other = await ctx.prisma.matchReview.create({
      data: {
        workspaceId: actor.workspaceId,
        candidateCompanyId: third.id,
        existingCompanyId: candidate.id,
        pairKey: [third.id, candidate.id].sort().join(':'),
        score: 0.8,
        reasons: [],
      },
    });

    await call(actor, 'post', `/reviews/${review.id}/merge`);
    const repointed = await ctx.prisma.matchReview.findUniqueOrThrow({ where: { id: other.id } });
    expect(repointed.status).toBe('PENDING');
    expect(repointed.existingCompanyId).toBe(existing.id);
    expect(repointed.pairKey).toBe([third.id, existing.id].sort().join(':'));
  });

  it('keeps reviews workspace-private and role-protected', async () => {
    const [owner, other] = [await newActor(), await newActor()];
    const { review } = await seedReviewPair(owner);
    expect((await call(other, 'get', '/reviews')).body.items).toEqual([]);
    expect((await call(other, 'post', `/reviews/${review.id}/merge`)).status).toBe(404);
    expect((await call(other, 'post', `/reviews/${review.id}/dismiss`)).status).toBe(404);

    await ctx.prisma.workspaceMember.create({
      data: { workspaceId: owner.workspaceId, userId: other.userId, role: 'VIEWER' },
    });
    expect(
      (await call(other, 'post', `/reviews/${review.id}/merge`, owner.workspaceId)).status,
    ).toBe(403);
    expect((await call(other, 'get', '/reviews', owner.workspaceId)).status).toBe(200);
  });
});

describe('openapi', () => {
  it('documents the new endpoints', async () => {
    const json = await request(ctx.server).get('/docs/json');
    expect(Object.keys(json.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/projects',
        '/api/v1/projects/{id}',
        '/api/v1/projects/{projectId}/runs',
        '/api/v1/runs/{id}',
        '/api/v1/runs/{id}/progress',
        '/api/v1/runs/{id}/cancel',
        '/api/v1/runs/{id}/results',
        '/api/v1/companies',
        '/api/v1/reviews',
        '/api/v1/reviews/{id}/merge',
      ]),
    );
  });
});
