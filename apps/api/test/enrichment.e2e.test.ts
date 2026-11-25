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
  queue = new Queue('company-enrichment', { connection: redis.duplicate() });
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

function createCompany(
  workspaceId: string,
  extra: Record<string, unknown> = {},
  name = `Acme ${randomUUID().slice(0, 6)}`,
) {
  return ctx.prisma.company.create({
    data: {
      workspaceId,
      displayName: name,
      nameKey: name.toLowerCase(),
      coreName: name.toLowerCase(),
      nameTokens: [name.toLowerCase()],
      coreTokens: [name.toLowerCase()],
      country: 'PK',
      city: 'Lahore',
      ...extra,
    },
  });
}

describe('POST /companies/:id/enrich', () => {
  it('queues a run, and a repeated call returns the same run (idempotent)', async () => {
    const actor = await newActor();
    const company = await createCompany(actor.workspaceId);

    const first = await call(actor, 'post', `/companies/${company.id}/enrich`);
    expect(first.status).toBe(202);
    expect(first.body.reused).toBe(false);
    expect(first.body.run).toMatchObject({
      companyId: company.id,
      status: 'QUEUED',
      contactsFound: 0,
      errors: [],
    });

    const second = await call(actor, 'post', `/companies/${company.id}/enrich`);
    expect(second.status).toBe(202);
    expect(second.body.reused).toBe(true);
    expect(second.body.run.id).toBe(first.body.run.id);

    expect(await ctx.prisma.extractionRun.count({ where: { companyId: company.id } })).toBe(1);
    const job = await queue.getJob(`enrich-${first.body.run.id}`);
    expect(job?.data).toEqual({ runId: first.body.run.id });
  });

  it('simultaneous requests share one run (database-enforced)', async () => {
    const actor = await newActor();
    const company = await createCompany(actor.workspaceId);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => call(actor, 'post', `/companies/${company.id}/enrich`)),
    );
    expect(responses.every((r) => r.status === 202)).toBe(true);
    expect(new Set(responses.map((r) => r.body.run.id)).size).toBe(1);
    expect(await ctx.prisma.extractionRun.count({ where: { companyId: company.id } })).toBe(1);
  });

  it('starts a new run once the previous one has finished', async () => {
    const actor = await newActor();
    const company = await createCompany(actor.workspaceId);
    const first = await call(actor, 'post', `/companies/${company.id}/enrich`);
    await ctx.prisma.extractionRun.update({
      where: { id: first.body.run.id },
      data: { status: 'COMPLETED', activeKey: null, finishedAt: new Date() },
    });
    const second = await call(actor, 'post', `/companies/${company.id}/enrich`);
    expect(second.body.reused).toBe(false);
    expect(second.body.run.id).not.toBe(first.body.run.id);
  });

  it('is workspace scoped, role protected and validates the id', async () => {
    const [owner, outsider] = [await newActor(), await newActor()];
    const company = await createCompany(owner.workspaceId);

    expect((await call(outsider, 'post', `/companies/${company.id}/enrich`)).status).toBe(404);
    expect((await call(owner, 'post', `/companies/${randomUUID()}/enrich`)).status).toBe(404);
    expect((await call(owner, 'post', '/companies/not-a-uuid/enrich')).status).toBe(400);

    await ctx.prisma.workspaceMember.create({
      data: { workspaceId: owner.workspaceId, userId: outsider.userId, role: 'VIEWER' },
    });
    expect(
      (await call(outsider, 'post', `/companies/${company.id}/enrich`, owner.workspaceId)).status,
    ).toBe(403);
    expect(await ctx.prisma.extractionRun.count({ where: { companyId: company.id } })).toBe(0);

    const anonymous = await request(ctx.server).post(`/api/v1/companies/${company.id}/enrich`);
    expect(anonymous.status).toBe(401);
  });

  it('refuses to enrich a merged company', async () => {
    const actor = await newActor();
    const survivor = await createCompany(actor.workspaceId);
    const merged = await createCompany(actor.workspaceId, {
      status: 'MERGED',
      mergedIntoId: survivor.id,
    });
    expect((await call(actor, 'post', `/companies/${merged.id}/enrich`)).status).toBe(409);
  });
});

describe('GET /companies/:id/sources and /contacts', () => {
  async function seeded() {
    const actor = await newActor();
    const company = await createCompany(actor.workspaceId, {
      website: 'https://acme-tech.com/',
      domain: 'acme-tech.com',
      websiteStatus: 'VERIFIED',
      emailStatus: 'VERIFIED',
      careersStatus: 'VERIFIED',
    });
    const page = await ctx.prisma.companyPage.create({
      data: {
        companyId: company.id,
        workspaceId: actor.workspaceId,
        url: 'https://acme-tech.com/careers',
        type: 'CAREERS',
        typeConfidence: 0.9,
        fetchStatus: 'FETCHED',
        httpStatus: 200,
        fetchedAt: new Date(),
      },
    });
    const base = {
      companyId: company.id,
      workspaceId: actor.workspaceId,
      verificationStatus: 'VERIFIED' as const,
      verificationMethod: 'PUBLISHED_ON_VERIFIED_SITE',
      extractionMethod: 'MAILTO',
      sourceUrl: page.url,
      sourcePageId: page.id,
      extractedAt: new Date('2026-11-25T10:00:00Z'),
      lastSeenAt: new Date('2026-11-25T10:00:00Z'),
    };
    await ctx.prisma.companyContact.createMany({
      data: [
        {
          ...base,
          kind: 'EMAIL',
          value: 'careers@acme-tech.com',
          category: 'CAREERS',
          confidence: 0.95,
        },
        {
          ...base,
          kind: 'EMAIL',
          value: 'info@acme-tech.com',
          category: 'GENERAL',
          confidence: 0.85,
        },
        {
          ...base,
          kind: 'LINKEDIN',
          value: 'https://www.linkedin.com/company/acme-tech',
          confidence: 0.8,
          extractionMethod: 'LINK',
        },
      ],
    });
    await ctx.prisma.companyReview.create({
      data: {
        workspaceId: actor.workspaceId,
        companyId: company.id,
        subjectKey: 'acme-tech.com',
        subjectUrl: 'https://acme-tech.com/',
        decision: 'OFFICIAL',
        confidence: 0.85,
        status: 'APPROVED',
        evidence: [{ signal: 'NAME_ON_PAGE', detail: 'Company name found in title', weight: 0.35 }],
      },
    });
    await ctx.prisma.companyReview.create({
      data: {
        workspaceId: actor.workspaceId,
        companyId: company.id,
        subjectKey: 'acme-tech.net',
        subjectUrl: 'https://acme-tech.net/',
        decision: 'REJECTED',
        confidence: 0.9,
        status: 'REJECTED',
        evidence: [{ signal: 'PARKED_OR_PLACEHOLDER', detail: 'parked', weight: -0.8 }],
      },
    });
    return { actor, company, page };
  }

  it('returns the website decision with evidence, pages, rejected candidates and runs', async () => {
    const { actor, company } = await seeded();
    await call(actor, 'post', `/companies/${company.id}/enrich`);

    const response = await call(actor, 'get', `/companies/${company.id}/sources`);
    expect(response.status).toBe(200);
    expect(response.body.website).toMatchObject({
      url: 'https://acme-tech.com/',
      status: 'VERIFIED',
      review: { decision: 'OFFICIAL', domain: 'acme-tech.com', status: 'APPROVED' },
    });
    expect(response.body.website.review.evidence[0]).toMatchObject({ signal: 'NAME_ON_PAGE' });
    expect(response.body.pages).toEqual([
      expect.objectContaining({
        type: 'CAREERS',
        fetchStatus: 'FETCHED',
        url: 'https://acme-tech.com/careers',
      }),
    ]);
    expect(response.body.candidates.map((c: { domain: string }) => c.domain).sort()).toEqual([
      'acme-tech.com',
      'acme-tech.net',
    ]);
    expect(
      response.body.candidates.find((c: { domain: string }) => c.domain === 'acme-tech.net'),
    ).toMatchObject({
      status: 'REJECTED',
    });
    expect(response.body.runs).toHaveLength(1);
    expect(response.body.careersStatus).toBe('VERIFIED');
  });

  it('lists contacts with source, timestamp, confidence and verification status', async () => {
    const { actor, company } = await seeded();
    const response = await call(actor, 'get', `/companies/${company.id}/contacts`);
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(3);
    for (const contact of response.body.items) {
      expect(contact.sourceUrl).toMatch(/^https:\/\/acme-tech\.com\//);
      expect(contact.extractedAt).toBe('2026-11-25T10:00:00.000Z');
      expect(typeof contact.confidence).toBe('number');
      expect(contact.verificationStatus).toBe('VERIFIED');
    }
    expect(
      response.body.items.find((c: { value: string }) => c.value === 'careers@acme-tech.com'),
    ).toMatchObject({
      kind: 'EMAIL',
      category: 'CAREERS',
    });
  });

  it('filters by kind and category and rejects bad filters', async () => {
    const { actor, company } = await seeded();
    const emails = await call(actor, 'get', `/companies/${company.id}/contacts?kind=EMAIL`);
    expect(emails.body.items.map((c: { kind: string }) => c.kind)).toEqual(['EMAIL', 'EMAIL']);
    const careers = await call(actor, 'get', `/companies/${company.id}/contacts?category=CAREERS`);
    expect(careers.body.items.map((c: { value: string }) => c.value)).toEqual([
      'careers@acme-tech.com',
    ]);
    expect(
      (await call(actor, 'get', `/companies/${company.id}/contacts?category=NOPE`)).status,
    ).toBe(400);
  });

  it('returns an empty list — never invented contacts — for an un-enriched company', async () => {
    const actor = await newActor();
    const company = await createCompany(actor.workspaceId);
    const contacts = await call(actor, 'get', `/companies/${company.id}/contacts`);
    expect(contacts.body).toEqual({ companyId: company.id, items: [] });
    const sources = await call(actor, 'get', `/companies/${company.id}/sources`);
    expect(sources.body).toMatchObject({
      website: { url: null, status: 'MISSING', review: null },
      pages: [],
      candidates: [],
      runs: [],
      lastEnrichedAt: null,
    });
  });

  it('does not leak across workspaces; viewers may read', async () => {
    const { actor, company } = await seeded();
    const outsider = await newActor();
    expect((await call(outsider, 'get', `/companies/${company.id}/contacts`)).status).toBe(404);
    expect((await call(outsider, 'get', `/companies/${company.id}/sources`)).status).toBe(404);

    await ctx.prisma.workspaceMember.create({
      data: { workspaceId: actor.workspaceId, userId: outsider.userId, role: 'VIEWER' },
    });
    expect(
      (await call(outsider, 'get', `/companies/${company.id}/contacts`, actor.workspaceId)).status,
    ).toBe(200);
  });
});

describe('website review decisions', () => {
  it('rejecting the current website removes it and everything harvested from it, for good', async () => {
    const actor = await newActor();
    const company = await createCompany(actor.workspaceId, {
      website: 'https://wrong-site.com/',
      domain: 'wrong-site.com',
      websiteStatus: 'VERIFIED',
      emailStatus: 'VERIFIED',
      careersStatus: 'VERIFIED',
    });
    await ctx.prisma.companyIdentity.create({
      data: {
        companyId: company.id,
        workspaceId: actor.workspaceId,
        type: 'DOMAIN',
        value: 'wrong-site.com',
      },
    });
    await ctx.prisma.companyContact.create({
      data: {
        companyId: company.id,
        workspaceId: actor.workspaceId,
        kind: 'EMAIL',
        value: 'hr@wrong-site.com',
        category: 'HR',
        confidence: 0.9,
        verificationStatus: 'VERIFIED',
        verificationMethod: 'PUBLISHED_ON_VERIFIED_SITE',
        extractionMethod: 'MAILTO',
        sourceUrl: 'https://wrong-site.com/contact',
        extractedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    const review = await ctx.prisma.companyReview.create({
      data: {
        workspaceId: actor.workspaceId,
        companyId: company.id,
        subjectKey: 'wrong-site.com',
        subjectUrl: 'https://wrong-site.com/',
        decision: 'OFFICIAL',
        confidence: 0.7,
        status: 'APPROVED',
        evidence: [],
      },
    });

    const rejected = await call(actor, 'post', `/website-reviews/${review.id}/reject`);
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', decidedManually: true });

    const after = await ctx.prisma.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after).toMatchObject({
      website: null,
      domain: null,
      websiteStatus: 'FAILED',
      emailStatus: 'MISSING',
      careersStatus: 'MISSING',
    });
    expect(await ctx.prisma.companyContact.count({ where: { companyId: company.id } })).toBe(0);
    expect(
      await ctx.prisma.companyIdentity.count({ where: { companyId: company.id, type: 'DOMAIN' } }),
    ).toBe(0);

    // idempotent
    expect((await call(actor, 'post', `/website-reviews/${review.id}/reject`)).status).toBe(200);
  });

  it('approving a candidate makes it the company website', async () => {
    const actor = await newActor();
    const company = await createCompany(actor.workspaceId);
    const review = await ctx.prisma.companyReview.create({
      data: {
        workspaceId: actor.workspaceId,
        companyId: company.id,
        subjectKey: 'acme-tech.com',
        subjectUrl: 'https://acme-tech.com/',
        decision: 'UNCERTAIN',
        confidence: 0.5,
        status: 'PENDING',
        evidence: [],
      },
    });
    const approved = await call(actor, 'post', `/website-reviews/${review.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', decidedManually: true });
    expect(await ctx.prisma.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject(
      {
        website: 'https://acme-tech.com/',
        domain: 'acme-tech.com',
        websiteStatus: 'VERIFIED',
      },
    );
    expect(
      await ctx.prisma.companyIdentity.count({
        where: { companyId: company.id, value: 'acme-tech.com' },
      }),
    ).toBe(1);
  });

  it('refuses a domain that belongs to another company, and enforces roles and scope', async () => {
    const actor = await newActor();
    const owner = await createCompany(actor.workspaceId, {
      domain: 'taken.com',
      website: 'https://taken.com/',
    });
    await ctx.prisma.companyIdentity.create({
      data: {
        companyId: owner.id,
        workspaceId: actor.workspaceId,
        type: 'DOMAIN',
        value: 'taken.com',
      },
    });
    const other = await createCompany(actor.workspaceId);
    const review = await ctx.prisma.companyReview.create({
      data: {
        workspaceId: actor.workspaceId,
        companyId: other.id,
        subjectKey: 'taken.com',
        subjectUrl: 'https://taken.com/',
        decision: 'UNCERTAIN',
        confidence: 0.5,
        status: 'PENDING',
        evidence: [],
      },
    });
    expect((await call(actor, 'post', `/website-reviews/${review.id}/approve`)).status).toBe(409);

    const outsider = await newActor();
    expect((await call(outsider, 'post', `/website-reviews/${review.id}/reject`)).status).toBe(404);
    await ctx.prisma.workspaceMember.create({
      data: { workspaceId: actor.workspaceId, userId: outsider.userId, role: 'VIEWER' },
    });
    expect(
      (await call(outsider, 'post', `/website-reviews/${review.id}/reject`, actor.workspaceId))
        .status,
    ).toBe(403);
  });
});

describe('openapi', () => {
  it('documents the enrichment endpoints', async () => {
    const json = await request(ctx.server).get('/docs/json');
    expect(Object.keys(json.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/companies/{id}/enrich',
        '/api/v1/companies/{id}/sources',
        '/api/v1/companies/{id}/contacts',
      ]),
    );
  });
});
