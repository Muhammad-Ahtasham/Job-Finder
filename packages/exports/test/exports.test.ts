import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPANY_COLUMNS,
  JOB_COLUMNS,
  companyWhere,
  csvLine,
  jobWhere,
  openCsv,
  openXlsx,
  sanitizeCell,
} from '../src';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jf-exports-test-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const PAYLOADS = [
  '=HYPERLINK("http://evil.example","click")',
  '+1+1',
  '-2+3',
  '@SUM(A1:A9)',
  '\t=1+1',
  '\r=1+1',
  '  =1+1',
  "=cmd|' /C calc'!A0",
];

describe('sanitizeCell', () => {
  it('neutralises every formula trigger, including after whitespace', () => {
    for (const payload of PAYLOADS) {
      const out = sanitizeCell(payload) as string;
      expect(out.startsWith("'"), payload).toBe(true);
    }
  });
  it('leaves ordinary text and real numbers alone', () => {
    expect(sanitizeCell('Acme Technologies')).toBe('Acme Technologies');
    expect(sanitizeCell('C++ developer')).toBe('C++ developer');
    expect(sanitizeCell('https://acme.example/jobs?a=1&b=-2')).toBe(
      'https://acme.example/jobs?a=1&b=-2',
    );
    expect(sanitizeCell('a=b')).toBe('a=b');
    expect(sanitizeCell(-5)).toBe(-5);
    expect(sanitizeCell(0)).toBe(0);
    expect(sanitizeCell(null)).toBe('');
    expect(sanitizeCell(undefined)).toBe('');
  });
  it('removes control characters', () => {
    expect(sanitizeCell('a\u0000b\u0007c')).toBe('abc');
  });
});

describe('csvLine', () => {
  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvLine(['a,b', 'say "hi"', 'x\ny', 1, true])).toBe(
      '"a,b","say ""hi""","x\ny",1,true\r\n',
    );
  });
});

describe('file writers', () => {
  it('writes a CSV with a BOM, a header and sanitised rows', async () => {
    const path = join(dir, 'a.csv');
    const sink = await openCsv(path, ['Company', 'Note', 'Count']);
    await sink.write(['Acme, Inc.', PAYLOADS[0]!, 3]);
    await sink.write(['Ünïcode ✓', null, -1]);
    await sink.close();
    const text = await readFile(path, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('Company,Note,Count');
    expect(lines[1]).toBe(`"Acme, Inc.","'=HYPERLINK(""http://evil.example"",""click"")",3`);
    expect(lines[2]).toBe('Ünïcode ✓,,-1');
  });

  it('writes an XLSX whose text cells are text, never formulas', async () => {
    const path = join(dir, 'a.xlsx');
    const sink = await openXlsx(path, 'Companies', COMPANY_COLUMNS);
    await sink.write(
      ['Acme', ...PAYLOADS.slice(0, 4), 'x', 'y', 'z', 'w', 'v', 'u', 12].slice(
        0,
        COMPANY_COLUMNS.length,
      ),
    );
    await sink.write(
      Array.from({ length: COMPANY_COLUMNS.length }, (_, i) => (i === 10 ? 7 : `v${i}`)),
    );
    await sink.close();

    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(path);
    const sheet = book.getWorksheet('Companies')!;
    expect(sheet.getRow(1).values).toEqual([undefined, ...COMPANY_COLUMNS.map((c) => c.header)]);
    const first = sheet.getRow(2);
    for (const col of [2, 3, 4, 5]) {
      const cell = first.getCell(col);
      expect(typeof cell.value, `column ${col}`).toBe('string');
      expect((cell.value as string).startsWith("'")).toBe(true);
      expect(cell.formula).toBeUndefined();
    }
    expect(sheet.getRow(3).getCell(11).value).toBe(7);
    expect(sheet.rowCount).toBe(3);
  });

  it('has the documented columns', () => {
    expect(COMPANY_COLUMNS.map((c) => c.header)).toEqual([
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
    expect(JOB_COLUMNS.map((c) => c.header)).toEqual([
      'Company name',
      'Job title',
      'Location',
      'Employment type',
      'Workplace type',
      'Skills',
      'Experience',
      'Match score',
      'Job status',
      'Publication date',
      'Application URL',
      'Source URL',
      'Last verified',
    ]);
  });
});

describe('column mapping', () => {
  it('formats a job row', () => {
    const row = {
      companyName: 'Acme',
      title: '=Evil()',
      location: 'Lahore',
      employmentType: 'FULL_TIME',
      workplaceType: 'UNKNOWN',
      skills: ['Node.js', 'SQL'],
      minYears: 3,
      maxYears: 5,
      matchScore: 86.54,
      status: 'OPEN',
      publishedAt: new Date('2026-11-10T08:00:00Z'),
      applicationUrl: null,
      sourceUrl: 'https://x.example/1',
      lastVerified: new Date('2026-11-20T00:00:00Z'),
    };
    const values = JOB_COLUMNS.map((c) => c.value(row));
    expect(values).toEqual([
      'Acme',
      '=Evil()',
      'Lahore',
      'Full time',
      null,
      'Node.js; SQL',
      '3-5 years',
      86.5,
      'Open',
      '2026-11-10',
      null,
      'https://x.example/1',
      '2026-11-20T00:00:00.000Z',
    ]);
  });
});

describe('filters', () => {
  it('always scope to the workspace and apply each filter', () => {
    const where = companyWhere('ws-1', {
      q: 'acme',
      hiring: true,
      hasHrEmail: false,
      projectId: 'p1',
    });
    expect(where.workspaceId).toBe('ws-1');
    expect((where.AND as unknown[]).length).toBe(4);
    expect(jobWhere('ws-1', { status: 'OPEN', skill: 'node' })).toMatchObject({
      workspaceId: 'ws-1',
      status: 'OPEN',
    });
  });
});
