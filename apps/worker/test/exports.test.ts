import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import Redis from 'ioredis';
import type { PrismaClient } from '@jobfinder/database';
import { FsObjectStorage } from '@jobfinder/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV } from '../src/config/env.token';
import { ExportProcessor } from '../src/exports/export-processor';
import { ExportQueueService } from '../src/exports/export-queue.service';
import { ExportsModule } from '../src/exports/exports.module';
import { OBJECT_STORAGE } from '../src/exports/exports.tokens';
import { InfrastructureModule, PRISMA } from '../src/infrastructure.module';
import { createCompany, createWorkspace } from './enrichment-helpers';

let moduleRef: TestingModule;
let redis: Redis;
let prisma: PrismaClient;
let processor: ExportProcessor;
let queue: ExportQueueService;
let storage: FsObjectStorage;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jf-worker-exports-'));
  storage = new FsObjectStorage(dir);
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  moduleRef = await Test.createTestingModule({ imports: [InfrastructureModule, ExportsModule] })
    .overrideProvider(OBJECT_STORAGE)
    .useValue(storage)
    .compile();
  await moduleRef.init();
  prisma = moduleRef.get<PrismaClient>(PRISMA);
  processor = moduleRef.get(ExportProcessor);
  queue = moduleRef.get(ExportQueueService);
});
afterAll(async () => {
  await moduleRef.close();
  redis.disconnect();
  await rm(dir, { recursive: true, force: true });
});

async function seed() {
  const fx = await createWorkspace(prisma);
  const mk = (name: string, extra: Record<string, unknown> = {}) =>
    createCompany(prisma, fx.workspaceId, extra, name);
  const alpha = await mk('Alpha Soft', {
    city: 'Lahore',
    website: 'https://alpha.example',
    websiteStatus: 'VERIFIED',
    careersStatus: 'VERIFIED',
  });
  const beta = await mk('=HYPERLINK("http://evil.example","x")', { city: 'Karachi' });
  const gamma = await mk('Gamma Labs', { city: 'Lahore' });
  await prisma.companyContact.create({
    data: {
      companyId: alpha.id,
      workspaceId: fx.workspaceId,
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
  });

  const project = await prisma.searchProject.create({
    data: {
      workspaceId: fx.workspaceId,
      name: 'Lahore Software!',
      city: 'Lahore',
      industry: 'Software',
      keywords: ['x'],
    },
  });
  const run = await prisma.searchRun.create({
    data: { projectId: project.id, workspaceId: fx.workspaceId, config: {} },
  });
  for (const c of [alpha, beta]) {
    const cs = await prisma.companySource.create({
      data: {
        companyId: c.id,
        workspaceId: fx.workspaceId,
        providerId: 'fixture',
        sourceKey: `k-${c.id}`,
        rawName: c.displayName,
        sourceUrl: `https://dir.example/${c.id}`,
        retrievedAt: new Date(),
      },
    });
    await prisma.discoveryResult.create({
      data: {
        runId: run.id,
        workspaceId: fx.workspaceId,
        companyId: c.id,
        companySourceId: cs.id,
        providerId: 'fixture',
        sourceKey: cs.sourceKey,
        outcome: 'CREATED',
      },
    });
  }

  const source = await prisma.jobSource.create({
    data: {
      workspaceId: fx.workspaceId,
      companyId: alpha.id,
      providerId: 'greenhouse',
      boardKey: 'alpha',
      boardUrl: 'https://boards.greenhouse.io/alpha',
    },
  });
  const mkJob = (externalId: string, title: string, extra: Record<string, unknown> = {}) =>
    prisma.job.create({
      data: {
        workspaceId: fx.workspaceId,
        companyId: alpha.id,
        sourceId: source.id,
        externalId,
        fingerprint: externalId,
        title,
        sourceUrl: `https://x.example/${externalId}`,
        extraction: 'API',
        ...extra,
      },
    });
  const j1 = await mkJob('1', 'Backend Engineer', {
    location: 'Lahore',
    minYearsExperience: 3,
    maxYearsExperience: 5,
    employmentType: 'FULL_TIME',
    skills: {
      create: [{ skillKey: 'nodejs', name: 'Node.js', kind: 'REQUIRED', source: 'RULES' }],
    },
  });
  const j2 = await mkJob('2', '-2+3 Designer', { roleCategory: 'DESIGN' });
  await mkJob('3', 'Old Role', { status: 'CLOSED' });
  const match = (jobId: string, score: number) =>
    prisma.jobMatch.create({
      data: {
        workspaceId: fx.workspaceId,
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
        inputHash: `${jobId}`,
      },
    });
  await match(j1.id, 90);
  await match(j2.id, 40);
  return { fx, project, alpha, beta, gamma };
}

async function request(fx: { workspaceId: string; userId: string }, over: Record<string, unknown>) {
  const row = await prisma.export.create({
    data: {
      workspaceId: fx.workspaceId,
      requestedById: fx.userId,
      type: 'COMPANIES',
      format: 'CSV',
      scope: 'ALL',
      ...over,
    } as never,
  });
  await processor.process(row.id);
  return prisma.export.findUniqueOrThrow({ where: { id: row.id } });
}

async function csvRows(key: string): Promise<string[][]> {
  const { stream } = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  const text = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  const lines = text.split('\r\n').filter(Boolean);
  // enough of a parser for these fixtures: quoted fields with doubled quotes
  return lines.map((line) => {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  });
}

describe('company exports', () => {
  it('exports all companies as CSV with the documented fields, and neutralises formulas', async () => {
    const { fx } = await seed();
    await seed(); // another workspace: must never leak in
    const done = await request(fx, {});
    expect(done).toMatchObject({
      status: 'COMPLETED',
      rowCount: 3,
      rowsProcessed: 3,
      rowsTotal: 3,
      attempts: 1,
    });
    expect(done.fileName).toMatch(/^companies-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(done.storageKey).toBe(`exports/${fx.workspaceId}/${done.id}.csv`);
    expect(done.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(done.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    const rows = await csvRows(done.storageKey!);
    expect(rows[0]).toEqual([
      'Company name',
      'Industry',
      'City',
      'Website',
      'Website verification status',
      'HR email',
      'Email verification status',
      'Careers page',
      'LinkedIn URL',
      'Hiring status',
      'Active job count',
      'Source URL',
      'Last verified',
    ]);
    expect(rows).toHaveLength(4);
    const byName = Object.fromEntries(rows.slice(1).map((r) => [r[0], r]));
    expect(byName['Alpha Soft']).toMatchObject({
      1: 'Software',
      2: 'Lahore',
      3: 'https://alpha.example',
      4: 'Verified',
      5: 'hr@alpha.example',
      6: 'Verified',
      9: 'Hiring',
      10: '2',
    });
    expect(byName['Alpha Soft']![11]).toMatch(/^https:\/\/dir\.example\//);
    // the formula in a company name is stored as text
    const evil = rows.find((r) => r[0]!.includes('HYPERLINK'))!;
    expect(evil[0]!.startsWith("'=")).toBe(true);
    expect(Object.keys(byName)).not.toContain('Other');
  });

  it('applies filters', async () => {
    const { fx } = await seed();
    const names = async (filters: object, extra: object = {}) => {
      const done = await request(fx, { scope: 'FILTERED', filters, ...extra });
      expect(done.status).toBe('COMPLETED');
      return (await csvRows(done.storageKey!)).slice(1).map((r) => r[0]);
    };
    expect(await names({ city: 'lahore' })).toEqual(['Alpha Soft', 'Gamma Labs']);
    expect(await names({ hasHrEmail: true })).toEqual(['Alpha Soft']);
    expect(await names({ hiring: false, hasWebsite: false })).toHaveLength(2);
    expect(await names({ q: 'gamma' })).toEqual(['Gamma Labs']);
  });

  it('exports only the companies of a project', async () => {
    const { fx, project } = await seed();
    const done = await request(fx, {
      scope: 'PROJECT',
      projectId: project.id,
      projectName: project.name,
    });
    expect(done.rowCount).toBe(2);
    expect(done.fileName).toMatch(/^companies-lahore-software-\d{4}/);
    const rows = await csvRows(done.storageKey!);
    expect(
      rows
        .slice(1)
        .map((r) => r[0])
        .sort(),
    ).toEqual(
      ['=' + 'HYPERLINK("http://evil.example","x")']
        .map((s) => `'${s}`)
        .concat('Alpha Soft')
        .sort(),
    );
  });
});

describe('job exports', () => {
  it('exports all jobs, with the documented fields', async () => {
    const { fx } = await seed();
    await seed();
    const done = await request(fx, { type: 'JOBS' });
    expect(done.rowCount).toBe(3);
    const rows = await csvRows(done.storageKey!);
    expect(rows[0]![1]).toBe('Job title');
    const backend = rows.find((r) => r[1] === 'Backend Engineer')!;
    expect(backend).toMatchObject({
      0: 'Alpha Soft',
      2: 'Lahore',
      3: 'Full time',
      5: 'Node.js',
      6: '3-5 years',
      7: '90',
      8: 'Open',
    });
    expect(rows.find((r) => r[1]!.includes('Designer'))![1]!.startsWith("'-2+3")).toBe(true);
  });

  it('filters jobs', async () => {
    const { fx } = await seed();
    const done = await request(fx, {
      type: 'JOBS',
      scope: 'FILTERED',
      filters: { status: 'CLOSED' },
    });
    expect((await csvRows(done.storageKey!)).slice(1).map((r) => r[1])).toEqual(['Old Role']);
  });

  it('exports a project’s job matches as XLSX, best first, with the project’s score', async () => {
    const { fx, project } = await seed();
    const done = await request(fx, {
      type: 'JOBS',
      format: 'XLSX',
      scope: 'PROJECT',
      projectId: project.id,
      projectName: project.name,
      filters: { minMatchScore: 50 },
    });
    expect(done).toMatchObject({ status: 'COMPLETED', rowCount: 1 });
    expect(done.fileName).toMatch(/\.xlsx$/);
    const { stream } = await storage.get(done.storageKey!);
    const book = new ExcelJS.Workbook();
    await book.xlsx.read(stream);
    const sheet = book.getWorksheet('Jobs')!;
    expect(sheet.rowCount).toBe(2);
    expect(sheet.getRow(2).getCell(2).value).toBe('Backend Engineer');
    expect(sheet.getRow(2).getCell(8).value).toBe(90);

    const all = await request(fx, {
      type: 'JOBS',
      format: 'XLSX',
      scope: 'PROJECT',
      projectId: project.id,
    });
    const book2 = new ExcelJS.Workbook();
    await book2.xlsx.read((await storage.get(all.storageKey!)).stream);
    expect([2, 3].map((r) => book2.getWorksheet('Jobs')!.getRow(r).getCell(8).value)).toEqual([
      90, 40,
    ]);
    expect(book2.getWorksheet('Jobs')!.getRow(3).getCell(2).value).toBe("'-2+3 Designer");
  });
});

describe('failures and retention', () => {
  it('fails clearly when the project is gone or the export is too large, and never reruns a finished one', async () => {
    const { fx, project } = await seed();
    await prisma.searchProject.delete({ where: { id: project.id } });
    const gone = await request(fx, { scope: 'PROJECT', projectId: project.id });
    expect(gone).toMatchObject({ status: 'FAILED', errorCode: 'PROJECT_NOT_FOUND' });
    expect(gone.storageKey).toBeNull();

    const env = moduleRef.get(ENV);
    const original = env.EXPORT_MAX_ROWS;
    (env as { EXPORT_MAX_ROWS: number }).EXPORT_MAX_ROWS = 1;
    try {
      const big = await request(fx, {});
      expect(big).toMatchObject({ status: 'FAILED', errorCode: 'EXPORT_TOO_LARGE' });
      expect(big.errorMessage).toMatch(/limit is 1/);
    } finally {
      (env as { EXPORT_MAX_ROWS: number }).EXPORT_MAX_ROWS = original;
    }

    const ok = await request(fx, {});
    await processor.process(ok.id); // already COMPLETED: a no-op
    expect((await prisma.export.findUniqueOrThrow({ where: { id: ok.id } })).attempts).toBe(1);
  });

  it('records a retry as QUEUED and a final failure as FAILED', async () => {
    const { fx } = await seed();
    const row = await prisma.export.create({
      data: {
        workspaceId: fx.workspaceId,
        type: 'COMPANIES',
        format: 'CSV',
        scope: 'ALL',
        status: 'RUNNING',
      },
    });
    await processor.markRetrying(row.id, new Error('disk hiccup'));
    expect(await prisma.export.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'QUEUED',
      errorCode: 'RETRYING',
    });
    await processor.markFailed(row.id, 'EXPORT_FAILED', 'giving up');
    expect(await prisma.export.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'FAILED',
      errorMessage: 'giving up',
    });
  });

  it('deletes files past their retention but keeps the history record', async () => {
    const { fx } = await seed();
    const done = await request(fx, {});
    await prisma.export.update({
      where: { id: done.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await processor.expireOld()).toBeGreaterThanOrEqual(1);
    const after = await prisma.export.findUniqueOrThrow({ where: { id: done.id } });
    expect(after).toMatchObject({ status: 'EXPIRED', storageKey: null, rowCount: 3 });
    await expect(storage.get(done.storageKey!)).rejects.toThrow();
    await expect(readFile(join(dir, done.storageKey!))).rejects.toThrow();
  });

  it('re-enqueues a QUEUED export the queue lost', async () => {
    const { fx } = await seed();
    const row = await prisma.export.create({
      data: {
        workspaceId: fx.workspaceId,
        type: 'COMPANIES',
        format: 'CSV',
        scope: 'ALL',
        createdAt: new Date(Date.now() - 3_600_000),
      },
    });
    const result = await queue.reconcile();
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    // the consumer picks it up and finishes it
    for (let i = 0; i < 40; i++) {
      const current = await prisma.export.findUniqueOrThrow({ where: { id: row.id } });
      if (current.status === 'COMPLETED') return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('the re-enqueued export was not processed');
  });
});
