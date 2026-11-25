import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieValue, createTestApp, newCredentials, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

interface Actor {
  cookie: string;
  workspaceId: string;
}
async function newActor(): Promise<Actor> {
  const r = await request(ctx.server).post('/api/v1/auth/register').send(newCredentials());
  return { cookie: `jf_session=${cookieValue(r)}`, workspaceId: r.body.workspaces[0].id };
}
const get = (a: Actor, path: string) =>
  request(ctx.server).get(`/api/v1${path}`).set('Cookie', a.cookie);

async function company(a: Actor, name: string, extra: Record<string, unknown> = {}) {
  return ctx.prisma.company.create({
    data: {
      workspaceId: a.workspaceId,
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

/** Three companies with different attributes, one project that found two of them, and jobs. */
async function seed(a: Actor) {
  const project = await ctx.prisma.searchProject.create({
    data: {
      workspaceId: a.workspaceId,
      name: `p-${randomUUID()}`,
      city: 'Lahore',
      industry: 'Software',
      keywords: ['software'],
    },
  });
  const run = await ctx.prisma.searchRun.create({
    data: { projectId: project.id, workspaceId: a.workspaceId, config: {}, candidatesFound: 3 },
  });
  const alpha = await company(a, 'Alpha Soft', {
    city: 'Lahore',
    website: 'https://alpha.example',
    websiteStatus: 'VERIFIED',
    careersStatus: 'VERIFIED',
    emailStatus: 'VERIFIED',
  });
  const beta = await company(a, 'Beta Works', {
    city: 'Karachi',
    website: 'https://beta.example',
    websiteStatus: 'UNVERIFIED',
  });
  const gamma = await company(a, 'Gamma Labs', { city: 'Lahore' });
  for (const c of [alpha, beta]) {
    const cs = await ctx.prisma.companySource.create({
      data: {
        companyId: c.id,
        workspaceId: a.workspaceId,
        providerId: 'fixture',
        sourceKey: `k-${c.id}`,
        rawName: c.displayName,
        retrievedAt: new Date(),
      },
    });
    await ctx.prisma.discoveryResult.create({
      data: {
        runId: run.id,
        workspaceId: a.workspaceId,
        companyId: c.id,
        companySourceId: cs.id,
        providerId: 'fixture',
        sourceKey: cs.sourceKey,
        outcome: 'CREATED',
      },
    });
  }
  await ctx.prisma.companyContact.createMany({
    data: [
      {
        companyId: alpha.id,
        workspaceId: a.workspaceId,
        kind: 'EMAIL',
        value: 'hr@alpha.example',
        category: 'HR',
        confidence: 0.9,
        verificationStatus: 'VERIFIED',
        verificationMethod: 'published',
        extractionMethod: 'mailto',
        sourceUrl: 'https://alpha.example/careers',
        extractedAt: new Date(),
        lastSeenAt: new Date(),
      },
      {
        companyId: alpha.id,
        workspaceId: a.workspaceId,
        kind: 'LINKEDIN',
        value: 'https://www.linkedin.com/company/alpha',
        confidence: 0.8,
        verificationStatus: 'VERIFIED',
        verificationMethod: 'published',
        extractionMethod: 'link',
        sourceUrl: 'https://alpha.example/',
        extractedAt: new Date(),
        lastSeenAt: new Date(),
      },
      // a generic mailbox is not an HR email
      {
        companyId: beta.id,
        workspaceId: a.workspaceId,
        kind: 'EMAIL',
        value: 'info@beta.example',
        category: 'GENERAL',
        confidence: 0.9,
        verificationStatus: 'VERIFIED',
        verificationMethod: 'published',
        extractionMethod: 'mailto',
        sourceUrl: 'https://beta.example/',
        extractedAt: new Date(),
        lastSeenAt: new Date(),
      },
    ],
  });
  await ctx.prisma.companyPage.create({
    data: {
      companyId: alpha.id,
      workspaceId: a.workspaceId,
      url: 'https://alpha.example/careers',
      type: 'CAREERS',
      typeConfidence: 0.9,
      fetchStatus: 'FETCHED',
    },
  });

  const mkSource = (c: { id: string }) =>
    ctx.prisma.jobSource.create({
      data: {
        workspaceId: a.workspaceId,
        companyId: c.id,
        providerId: 'greenhouse',
        boardKey: `b-${c.id}`,
        boardUrl: 'https://boards.greenhouse.io/x',
      },
    });
  const alphaSource = await mkSource(alpha);
  const mkJob = (
    sourceId: string,
    companyId: string,
    externalId: string,
    title: string,
    extra: Record<string, unknown> = {},
  ) =>
    ctx.prisma.job.create({
      data: {
        workspaceId: a.workspaceId,
        companyId,
        sourceId,
        externalId,
        fingerprint: externalId,
        title,
        sourceUrl: `https://x.example/${externalId}`,
        extraction: 'API',
        ...extra,
      },
    });
  const j1 = await mkJob(alphaSource.id, alpha.id, '1', 'Backend Engineer', {
    location: 'Lahore, Pakistan',
    roleCategory: 'SOFTWARE_ENGINEERING',
    analysisHash: 'h',
    minYearsExperience: 3,
    skills: {
      create: [{ skillKey: 'nodejs', name: 'Node.js', kind: 'REQUIRED', source: 'RULES' }],
    },
  });
  const j2 = await mkJob(alphaSource.id, alpha.id, '2', 'Product Designer', {
    location: 'Lahore',
    roleCategory: 'DESIGN',
  });
  await mkJob(alphaSource.id, alpha.id, '3', 'Old Role', { status: 'CLOSED' });
  const match = (jobId: string, score: number) =>
    ctx.prisma.jobMatch.create({
      data: {
        workspaceId: a.workspaceId,
        projectId: project.id,
        jobId,
        score,
        experienceFit: 'UNKNOWN',
        locationFit: 'MATCH',
        explanation: 'x',
        explanationSource: 'RULES',
        confidence: 0.6,
        provider: 'rules',
        model: 'rules',
        promptVersion: 'rules/v1',
        weights: {},
        inputHash: randomUUID(),
      },
    });
  await match(j1.id, 90);
  await match(j2.id, 40);
  return { project, alpha, beta, gamma, j1, j2 };
}

describe('GET /dashboard/summary', () => {
  it('counts the workspace only', async () => {
    const [a, other] = [await newActor(), await newActor()];
    await seed(a);
    const res = await get(a, '/dashboard/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companies: { total: 3, verifiedWebsites: 1, withCareersPage: 1, withHrEmail: 1, hiring: 1 },
      jobs: { open: 2, matched: 2 },
      projects: 1,
    });
    expect(res.body.recentRuns[0]).toMatchObject({ candidatesFound: 3, status: 'QUEUED' });
    expect((await get(other, '/dashboard/summary')).body).toMatchObject({
      companies: { total: 0 },
      jobs: { open: 0 },
      recentRuns: [],
    });
    expect((await request(ctx.server).get('/api/v1/dashboard/summary')).status).toBe(401);
  });
});

describe('GET /directory/companies', () => {
  it('returns rich rows with total, server-side paging and sorting', async () => {
    const a = await newActor();
    const { alpha } = await seed(a);
    const res = await get(a, '/directory/companies?sort=name&order=asc&pageSize=2');
    expect(res.body).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(res.body.items.map((c: { displayName: string }) => c.displayName)).toEqual([
      'Alpha Soft',
      'Beta Works',
    ]);
    const row = res.body.items[0];
    expect(row).toMatchObject({
      id: alpha.id,
      industries: ['Software'],
      city: 'Lahore',
      websiteStatus: 'VERIFIED',
      hrEmail: 'hr@alpha.example',
      careersUrl: 'https://alpha.example/careers',
      linkedin: 'https://www.linkedin.com/company/alpha',
      hiring: true,
      openJobs: 2,
      jobCount: 3,
    });
    expect(res.body.items[1]).toMatchObject({ hrEmail: null, hiring: false, jobCount: 0 });
    const p2 = await get(a, '/directory/companies?sort=name&order=asc&pageSize=2&page=2');
    expect(p2.body.items.map((c: { displayName: string }) => c.displayName)).toEqual([
      'Gamma Labs',
    ]);
    const byJobs = await get(a, '/directory/companies?sort=jobCount&order=desc');
    expect(byJobs.body.items[0].displayName).toBe('Alpha Soft');
  });

  it('filters', async () => {
    const a = await newActor();
    const { project } = await seed(a);
    const names = async (qs: string) =>
      (
        (await get(a, `/directory/companies?sort=name&order=asc&${qs}`)).body.items as {
          displayName: string;
        }[]
      ).map((c) => c.displayName);
    expect(await names('q=beta')).toEqual(['Beta Works']);
    expect(await names('city=lahore')).toEqual(['Alpha Soft', 'Gamma Labs']);
    expect(await names('industry=software')).toEqual(['Alpha Soft', 'Beta Works']);
    expect(await names('websiteStatus=UNVERIFIED')).toEqual(['Beta Works']);
    expect(await names('hasWebsite=false')).toEqual(['Gamma Labs']);
    expect(await names('hasHrEmail=true')).toEqual(['Alpha Soft']);
    expect(await names('hasHrEmail=false')).toEqual(['Beta Works', 'Gamma Labs']);
    expect(await names('hasCareersPage=true')).toEqual(['Alpha Soft']);
    expect(await names('hiring=true')).toEqual(['Alpha Soft']);
    expect(await names(`projectId=${project.id}`)).toEqual(['Alpha Soft', 'Beta Works']);
    expect(await names('hiring=true&city=karachi')).toEqual([]);
    expect((await get(a, '/directory/companies?sort=bogus')).status).toBe(400);
    expect((await get(a, '/directory/companies?pageSize=1000')).status).toBe(400);
    expect(
      (await get(await newActor(), `/directory/companies?projectId=${project.id}`)).status,
    ).toBe(404);
  });
});

describe('GET /directory/jobs', () => {
  it('returns job rows with skills, experience and the project match score', async () => {
    const a = await newActor();
    const { project, j1 } = await seed(a);
    const res = await get(
      a,
      `/directory/jobs?projectId=${project.id}&status=OPEN&sort=title&order=asc`,
    );
    expect(res.body.total).toBe(2);
    expect(res.body.items[0]).toMatchObject({
      id: j1.id,
      title: 'Backend Engineer',
      companyName: 'Alpha Soft',
      city: 'Lahore, Pakistan',
      minYears: 3,
      matchScore: 90,
      status: 'OPEN',
      analysisState: 'ANALYZED',
      skills: [{ name: 'Node.js', kind: 'REQUIRED' }],
    });
    expect(res.body.items[1]).toMatchObject({
      title: 'Product Designer',
      matchScore: 40,
      analysisState: 'PENDING',
    });
  });

  it('filters, sorts by match and pages server-side', async () => {
    const a = await newActor();
    const { project } = await seed(a);
    const titles = async (qs: string) =>
      ((await get(a, `/directory/jobs?${qs}`)).body.items as { title: string }[]).map(
        (j) => j.title,
      );
    expect(await titles(`projectId=${project.id}&sort=match&order=desc`)).toEqual(
      ['Backend Engineer', 'Product Designer', 'Old Role'].slice(0, 2),
    );
    expect(await titles(`projectId=${project.id}&minMatchScore=50`)).toEqual(['Backend Engineer']);
    expect(await titles('minMatchScore=50')).toEqual(['Backend Engineer']);
    expect(await titles('status=CLOSED')).toEqual(['Old Role']);
    expect(await titles('role=DESIGN')).toEqual(['Product Designer']);
    expect(await titles('role=engineer')).toEqual(['Backend Engineer']);
    expect(await titles('skill=node')).toEqual(['Backend Engineer']);
    expect(await titles('q=alpha&status=OPEN&sort=title&order=asc')).toEqual([
      'Backend Engineer',
      'Product Designer',
    ]);
    expect(await titles('city=karachi')).toEqual([]);
    expect(await titles('industry=software&status=OPEN&sort=title&order=desc')).toEqual([
      'Product Designer',
      'Backend Engineer',
    ]);
    const page2 = await get(
      a,
      `/directory/jobs?status=OPEN&sort=title&order=asc&pageSize=1&page=2`,
    );
    expect(page2.body).toMatchObject({
      total: 2,
      totalPages: 2,
      items: [{ title: 'Product Designer' }],
    });
    expect((await get(a, '/directory/jobs?sort=match')).status).toBe(400);
    expect((await get(await newActor(), '/directory/jobs')).body.total).toBe(0);
  });
});

describe('facets', () => {
  it('lists the options that exist in the workspace', async () => {
    const a = await newActor();
    await seed(a);
    expect((await get(a, '/directory/facets')).body).toEqual({
      cities: ['Karachi', 'Lahore'],
      industries: ['Software'],
      roleCategories: ['DESIGN', 'SOFTWARE_ENGINEERING'],
    });
  });
});
