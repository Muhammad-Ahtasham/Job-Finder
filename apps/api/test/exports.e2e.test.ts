import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import request from 'supertest';
import { FsObjectStorage } from '@jobfinder/storage';
import { exportStorageConfig, loadApiEnv } from '@jobfinder/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExportLinksService } from '../src/exports/export-links.service';
import { cookieValue, createTestApp, newCredentials, type TestContext } from './helpers';

let ctx: TestContext;
let redis: Redis;
let queue: Queue;
let storage: FsObjectStorage;

beforeAll(async () => {
  ctx = await createTestApp();
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  queue = new Queue('exports', { connection: redis.duplicate() });
  const config = exportStorageConfig(loadApiEnv());
  if (config.driver !== 'fs') throw new Error('tests use the fs driver');
  storage = new FsObjectStorage(config.directory);
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
  const r = await request(ctx.server).post('/api/v1/auth/register').send(newCredentials());
  return {
    cookie: `jf_session=${cookieValue(r)}`,
    userId: r.body.user.id,
    workspaceId: r.body.workspaces[0].id,
  };
}
const call = (a: Actor, method: 'get' | 'post', path: string) =>
  request(ctx.server)[method](`/api/v1${path}`).set('Cookie', a.cookie);

async function project(a: Actor) {
  return ctx.prisma.searchProject.create({
    data: {
      workspaceId: a.workspaceId,
      name: `p-${randomUUID()}`,
      city: 'Lahore',
      industry: 'Software',
      keywords: ['x'],
    },
  });
}

/** A finished export with a real file in storage, as the worker would leave it. */
async function completed(a: Actor, over: Record<string, unknown> = {}) {
  const row = await ctx.prisma.export.create({
    data: {
      workspaceId: a.workspaceId,
      requestedById: a.userId,
      type: 'COMPANIES',
      format: 'CSV',
      scope: 'ALL',
      status: 'COMPLETED',
      fileName: 'companies-2026-11-28.csv',
      rowCount: 1,
      rowsProcessed: 1,
      rowsTotal: 1,
      sizeBytes: 22,
      finishedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...over,
    },
  });
  const key = `exports/${a.workspaceId}/${row.id}.csv`;
  await storage.put(key, Readable.from(['Company name\r\nAcme\r\n']), { contentType: 'text/csv' });
  return ctx.prisma.export.update({ where: { id: row.id }, data: { storageKey: key } });
}

describe('POST /exports', () => {
  it('queues an export and records its scope', async () => {
    const a = await newActor();
    const p = await project(a);

    const all = await call(a, 'post', '/exports').send({ type: 'COMPANIES', format: 'CSV' });
    expect(all.status).toBe(202);
    expect(all.body).toMatchObject({
      type: 'COMPANIES',
      format: 'CSV',
      scope: 'ALL',
      status: 'QUEUED',
      filters: {},
      progress: { rowsProcessed: 0, rowsTotal: null, percent: 0 },
      downloadable: false,
      fileName: null,
    });
    expect((await queue.getJob(`export-${all.body.id}`))?.data).toEqual({ exportId: all.body.id });

    const filtered = await call(a, 'post', '/exports').send({
      type: 'JOBS',
      format: 'XLSX',
      filters: { status: 'OPEN', skill: 'node' },
    });
    expect(filtered.body).toMatchObject({
      scope: 'FILTERED',
      format: 'XLSX',
      filters: { status: 'OPEN', skill: 'node' },
    });

    const forProject = await call(a, 'post', '/exports').send({
      type: 'JOBS',
      format: 'CSV',
      projectId: p.id,
      filters: { minMatchScore: 60 },
    });
    expect(forProject.body).toMatchObject({
      scope: 'PROJECT',
      projectId: p.id,
      projectName: p.name,
    });
    const row = await ctx.prisma.export.findUniqueOrThrow({ where: { id: forProject.body.id } });
    expect(row).toMatchObject({
      workspaceId: a.workspaceId,
      requestedById: a.userId,
      filters: { minMatchScore: 60 },
    });
  });

  it('validates the request', async () => {
    const a = await newActor();
    const bad: object[] = [
      {},
      { type: 'COMPANIES' },
      { type: 'PEOPLE', format: 'CSV' },
      { type: 'COMPANIES', format: 'PDF' },
      { type: 'COMPANIES', format: 'CSV', filters: { nope: 1 } },
      { type: 'COMPANIES', format: 'CSV', filters: { websiteStatus: 'MAYBE' } },
      { type: 'COMPANIES', format: 'CSV', filters: { status: 'OPEN' } }, // a job filter on a company export
      { type: 'COMPANIES', format: 'CSV', projectId: 'not-a-uuid' },
      { type: 'JOBS', format: 'CSV', filters: { minMatchScore: 50 } }, // needs a project
      { type: 'JOBS', format: 'CSV', projectId: randomUUID(), filters: { minMatchScore: 101 } },
      { type: 'COMPANIES', format: 'CSV', extra: true },
    ];
    for (const body of bad)
      expect((await call(a, 'post', '/exports').send(body)).status, JSON.stringify(body)).toBe(400);
    expect(
      (
        await call(a, 'post', '/exports').send({
          type: 'COMPANIES',
          format: 'CSV',
          projectId: randomUUID(),
        })
      ).status,
    ).toBe(404);
    expect(
      (await request(ctx.server).post('/api/v1/exports').send({ type: 'COMPANIES', format: 'CSV' }))
        .status,
    ).toBe(401);
  });

  it('does not let one workspace use another workspace’s project', async () => {
    const [a, b] = [await newActor(), await newActor()];
    const p = await project(a);
    const res = await call(b, 'post', '/exports').send({
      type: 'COMPANIES',
      format: 'CSV',
      projectId: p.id,
    });
    expect(res.status).toBe(404);
  });

  it('limits exports in progress per workspace', async () => {
    const a = await newActor();
    for (let i = 0; i < 3; i++) {
      expect(
        (await call(a, 'post', '/exports').send({ type: 'COMPANIES', format: 'CSV' })).status,
      ).toBe(202);
    }
    expect(
      (await call(a, 'post', '/exports').send({ type: 'COMPANIES', format: 'CSV' })).status,
    ).toBe(429);
  });
});

describe('history and status', () => {
  it('lists the history newest first, filters it and shows progress', async () => {
    const a = await newActor();
    const done = await completed(a);
    const running = await ctx.prisma.export.create({
      data: {
        workspaceId: a.workspaceId,
        type: 'JOBS',
        format: 'XLSX',
        scope: 'ALL',
        status: 'RUNNING',
        rowsTotal: 200,
        rowsProcessed: 50,
      },
    });
    const list = await call(a, 'get', '/exports');
    expect(list.status).toBe(200);
    expect(list.body.items.map((e: { id: string }) => e.id)).toEqual([running.id, done.id]);
    expect(list.body.items[0]).toMatchObject({
      status: 'RUNNING',
      progress: { rowsProcessed: 50, rowsTotal: 200, percent: 25 },
      downloadable: false,
    });
    expect(list.body.items[1]).toMatchObject({
      status: 'COMPLETED',
      progress: { percent: 100 },
      downloadable: true,
      fileName: 'companies-2026-11-28.csv',
      rowCount: 1,
    });
    expect(list.body.items[1]).not.toHaveProperty('storageKey');

    expect((await call(a, 'get', '/exports?status=COMPLETED')).body.items).toHaveLength(1);
    expect((await call(a, 'get', '/exports?type=JOBS')).body.items[0].id).toBe(running.id);
    const page = await call(a, 'get', '/exports?limit=1');
    expect(page.body.nextCursor).toBe(running.id);
    expect(
      (await call(a, 'get', `/exports?limit=1&cursor=${page.body.nextCursor}`)).body.items[0].id,
    ).toBe(done.id);
    expect((await call(a, 'get', '/exports?status=BOGUS')).status).toBe(400);

    expect((await call(a, 'get', `/exports/${running.id}`)).body).toMatchObject({
      id: running.id,
      status: 'RUNNING',
    });
  });

  it('shows failures and never exposes another workspace’s exports', async () => {
    const [a, b] = [await newActor(), await newActor()];
    const failed = await ctx.prisma.export.create({
      data: {
        workspaceId: a.workspaceId,
        type: 'COMPANIES',
        format: 'CSV',
        scope: 'ALL',
        status: 'FAILED',
        errorCode: 'EXPORT_TOO_LARGE',
        errorMessage: 'The export has 9 rows; the limit is 1.',
      },
    });
    expect((await call(a, 'get', `/exports/${failed.id}`)).body).toMatchObject({
      status: 'FAILED',
      errorCode: 'EXPORT_TOO_LARGE',
      downloadable: false,
    });

    expect((await call(b, 'get', '/exports')).body.items).toEqual([]);
    expect((await call(b, 'get', `/exports/${failed.id}`)).status).toBe(404);
    expect((await call(b, 'get', `/exports/${failed.id}/download`)).status).toBe(404);
    expect((await call(a, 'get', '/exports/not-a-uuid')).status).toBe(400);
    expect((await request(ctx.server).get('/api/v1/exports')).status).toBe(401);
    expect((await request(ctx.server).get(`/api/v1/exports/${failed.id}`)).status).toBe(401);
  });
});

describe('downloads', () => {
  it('redirects an authorised member to a short-lived link that serves the file', async () => {
    const a = await newActor();
    const e = await completed(a);

    const redirect = await call(a, 'get', `/exports/${e.id}/download`).redirects(0);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toMatch(
      new RegExp(`^/api/v1/exports/${e.id}/file\\?expires=\\d+&signature=[0-9a-f]{64}$`),
    );
    expect(redirect.headers['cache-control']).toBe('no-store');

    // The link works with no session at all.
    const file = await request(ctx.server).get(redirect.headers.location!);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    expect(file.headers['content-disposition']).toBe(
      'attachment; filename="companies-2026-11-28.csv"',
    );
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.text).toBe('Company name\r\nAcme\r\n');

    const json = await call(a, 'get', `/exports/${e.id}/download?mode=json`);
    expect(json.status).toBe(200);
    expect(json.body.url).toMatch(/\/file\?expires=/);
    const seconds = (new Date(json.body.expiresAt).getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(30);
    expect(seconds).toBeLessThanOrEqual(61);
  });

  it('rejects forged, tampered, expired and swapped links', async () => {
    const [a, b] = [await newActor(), await newActor()];
    const [one, two] = [await completed(a), await completed(a)];
    const links = ctx.app.get(ExportLinksService);

    const good = links.create(one.id).url;
    expect((await request(ctx.server).get(good)).status).toBe(200);

    expect(
      (await request(ctx.server).get(good.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).status,
    ).toBe(403);
    expect((await request(ctx.server).get(`/api/v1/exports/${one.id}/file`)).status).toBe(400);
    expect(
      (
        await request(ctx.server).get(
          `/api/v1/exports/${one.id}/file?expires=9999999999&signature=${'a'.repeat(64)}`,
        )
      ).status,
    ).toBe(403);
    // a link for one export does not open another
    expect((await request(ctx.server).get(good.replace(one.id, two.id))).status).toBe(403);
    // expired
    const old = links.create(one.id, Date.now() - 120_000).url;
    expect((await request(ctx.server).get(old)).status).toBe(403);
    // a far-future expiry cannot be used even with a valid signature
    expect(links.verify(one.id, Math.floor(Date.now() / 1000) + 3600, 'a'.repeat(64))).toBe(false);
    // another workspace's member cannot even obtain one
    expect((await call(b, 'get', `/exports/${one.id}/download`)).status).toBe(404);
  });

  it('refuses downloads that are not ready or no longer exist', async () => {
    const a = await newActor();
    const make = (data: Record<string, unknown>) =>
      ctx.prisma.export.create({
        data: {
          workspaceId: a.workspaceId,
          type: 'COMPANIES',
          format: 'CSV',
          scope: 'ALL',
          ...data,
        } as never,
      });
    const queued = await make({ status: 'QUEUED' });
    expect((await call(a, 'get', `/exports/${queued.id}/download`)).status).toBe(409);
    const running = await make({ status: 'RUNNING' });
    expect((await call(a, 'get', `/exports/${running.id}/download`)).status).toBe(409);
    const failed = await make({ status: 'FAILED', errorMessage: 'boom' });
    const f = await call(a, 'get', `/exports/${failed.id}/download`);
    expect(f.status).toBe(409);
    expect(f.body.message).toMatch(/boom/);
    const expired = await make({ status: 'EXPIRED' });
    expect((await call(a, 'get', `/exports/${expired.id}/download`)).status).toBe(410);
    const lapsed = await completed(a, { expiresAt: new Date(Date.now() - 1000) });
    expect((await call(a, 'get', `/exports/${lapsed.id}/download`)).status).toBe(410);
    expect((await request(ctx.server).get(`/api/v1/exports/${randomUUID()}/download`)).status).toBe(
      401,
    );

    // file deleted from storage behind our back
    const missing = await completed(a);
    await storage.delete(missing.storageKey!);
    const link = ctx.app.get(ExportLinksService).create(missing.id).url;
    expect((await request(ctx.server).get(link)).status).toBe(410);
  });
});
