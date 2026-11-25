import { describe, expect, it } from 'vitest';
import type { DomainRateLimiter } from '@jobfinder/enrichment';
import {
  AshbyProvider,
  GreenhouseProvider,
  JobProviderRegistry,
  LeverProvider,
  GenericHtmlJobProvider,
  ATSDetectionService,
} from '../src';

type Call = { url: string };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Scriptable fetch: responds per call index or by URL substring; records every call. */
function mockFetch(handler: (url: string, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string) => {
    calls.push({ url });
    return handler(url, calls.length - 1);
  }) as never;
  return { fn, calls };
}

const spyLimiter = () => {
  const hosts: string[] = [];
  const limiter: DomainRateLimiter = { acquire: async (host) => void hosts.push(host) };
  return { limiter, hosts };
};
const options = (fetchImpl: never, limiter?: DomainRateLimiter) => ({
  userAgent: 'TestBot/1',
  fetchImpl,
  rateLimiter: limiter ?? { acquire: async () => undefined },
});

// ---------------------------------------------------------------- Greenhouse

const ghJob = (id: number, extra: object = {}) => ({
  id,
  internal_job_id: 1,
  title: `Engineer ${id}`,
  updated_at: '2026-11-11T07:32:56-05:00',
  first_published: '2026-11-10T04:49:33-05:00',
  location: { name: 'Lahore, Pakistan' },
  absolute_url: `https://careers.acme.com/positions/${id}?gh_jid=${id}`,
  content:
    '&lt;div class=&quot;intro&quot;&gt;&lt;p&gt;Build &amp;amp; ship &lt;b&gt;things&lt;/b&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;TypeScript&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;',
  departments: [{ id: 1, name: 'Engineering', child_ids: [], parent_id: null }],
  ...extra,
});

describe('GreenhouseProvider', () => {
  it.each([
    ['https://boards.greenhouse.io/acme', 'acme'],
    ['https://boards.greenhouse.io/acme/jobs/123', 'acme'],
    ['https://job-boards.greenhouse.io/Acme', 'acme'],
    ['https://job-boards.eu.greenhouse.io/acme', 'acme'],
    ['https://boards.greenhouse.io/embed/job_board?for=acme', 'acme'],
    ['https://boards.greenhouse.io/embed/job_board/js?for=acme', 'acme'],
    ['https://boards-api.greenhouse.io/v1/boards/acme/jobs', 'acme'],
  ])('identifies %s', (url, token) => {
    const p = new GreenhouseProvider(options(mockFetch(() => json({})).fn));
    expect(p.identify(url)).toMatchObject({ providerId: 'greenhouse', boardKey: token });
  });

  it.each([
    'https://boards.greenhouse.io/',
    'https://boards.greenhouse.io/embed/job_board',
    'https://boards.greenhouse.io/bad%2Ftoken',
    'https://evil.com/boards.greenhouse.io/acme',
    'https://boards.greenhouse.io.evil.com/acme',
    'not a url',
  ])('does not identify %s', (url) => {
    const p = new GreenhouseProvider(options(mockFetch(() => json({})).fn));
    expect(p.identify(url)).toBeNull();
  });

  it('fetches with content=true and normalizes, preserving the original application URL', async () => {
    const m = mockFetch(() => json({ jobs: [ghJob(1), ghJob(2)], meta: { total: 2 } }));
    const { limiter, hosts } = spyLimiter();
    const p = new GreenhouseProvider(options(m.fn, limiter));
    const board = p.identify('https://boards.greenhouse.io/acme')!;
    const result = await p.fetchJobs(board);

    expect(m.calls.map((c) => c.url)).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true',
    ]);
    expect(hosts).toEqual(['boards-api.greenhouse.io']); // rate limiter consulted
    expect(result.outcome).toBe('JOBS');
    if (result.outcome !== 'JOBS') return;
    expect(result.authoritative).toBe(true);
    expect(result.jobs[0]).toMatchObject({
      providerId: 'greenhouse',
      boardKey: 'acme',
      externalId: '1',
      title: 'Engineer 1',
      location: 'Lahore, Pakistan',
      department: 'Engineering',
      applicationUrl: 'https://careers.acme.com/positions/1?gh_jid=1', // untouched
      sourceUrl: 'https://careers.acme.com/positions/1?gh_jid=1',
      employmentType: 'UNKNOWN',
      extraction: 'API',
    });
    expect(result.jobs[0]!.publishedAt?.toISOString()).toBe('2026-11-10T09:49:33.000Z');
    expect(result.jobs[0]!.description).toBe('Build & ship things\nTypeScript');
    expect(result.jobs[0]!.description).not.toMatch(/[<>]/); // HTML is never stored
  });

  it('distinguishes "no openings" from a failure', async () => {
    const p = new GreenhouseProvider(
      options(mockFetch(() => json({ jobs: [], meta: { total: 0 } })).fn),
    );
    const board = p.identify('https://boards.greenhouse.io/acme')!;
    expect(await p.fetchJobs(board)).toMatchObject({ outcome: 'NO_OPENINGS', authoritative: true });

    const missing = new GreenhouseProvider(options(mockFetch(() => json({ status: 404 }, 404)).fn));
    expect(await missing.fetchJobs(board)).toMatchObject({
      outcome: 'FAILED',
      error: { code: 'BOARD_NOT_FOUND', retryable: false, httpStatus: 404 },
    });

    const down = new GreenhouseProvider(options(mockFetch(() => json({}, 503)).fn));
    expect(await down.fetchJobs(board)).toMatchObject({
      outcome: 'FAILED',
      error: { retryable: true, httpStatus: 503 },
    });

    const limited = new GreenhouseProvider(
      options(mockFetch(() => json({}, 429, { 'retry-after': '7' })).fn),
    );
    expect(await limited.fetchJobs(board)).toMatchObject({
      outcome: 'FAILED',
      error: { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 7000 },
    });

    const network = new GreenhouseProvider(
      options((async () => {
        throw new TypeError('fetch failed');
      }) as never),
    );
    expect(await network.fetchJobs(board)).toMatchObject({
      outcome: 'FAILED',
      error: { retryable: true },
    });
  });

  it('never treats a malformed or truncated answer as complete', async () => {
    const board = { providerId: 'greenhouse', boardKey: 'acme', boardUrl: '' };
    const garbage = new GreenhouseProvider(options(mockFetch(() => json({ nope: true })).fn));
    expect(await garbage.fetchJobs(board)).toMatchObject({
      outcome: 'FAILED',
      error: { code: 'BAD_RESPONSE' },
    });

    const unreadable = new GreenhouseProvider(
      options(mockFetch(() => json({ jobs: [{ id: 1 }], meta: { total: 1 } })).fn),
    );
    expect(await unreadable.fetchJobs(board)).toMatchObject({
      outcome: 'FAILED',
      error: { code: 'BAD_RESPONSE' },
    });

    const truncated = new GreenhouseProvider(
      options(mockFetch(() => json({ jobs: [ghJob(1)], meta: { total: 5 } })).fn),
    );
    expect(await truncated.fetchJobs(board)).toMatchObject({
      outcome: 'JOBS',
      authoritative: false,
    });

    const partial = new GreenhouseProvider(
      options(mockFetch(() => json({ jobs: [ghJob(1), { id: 2 }], meta: { total: 2 } })).fn),
    );
    expect(await partial.fetchJobs(board)).toMatchObject({ outcome: 'JOBS', authoritative: false });
  });

  it('refuses to build an API URL from an unsafe board token', async () => {
    const m = mockFetch(() => json({ jobs: [] }));
    const p = new GreenhouseProvider(options(m.fn));
    const result = await p.fetchJobs({
      providerId: 'greenhouse',
      boardKey: '../../admin',
      boardUrl: '',
    });
    expect(result).toMatchObject({ outcome: 'FAILED', error: { code: 'INVALID_BOARD' } });
    expect(m.calls).toHaveLength(0);
  });

  it('collapses duplicate ids within one answer', async () => {
    const p = new GreenhouseProvider(
      options(mockFetch(() => json({ jobs: [ghJob(1), ghJob(1)], meta: { total: 2 } })).fn),
    );
    const result = await p.fetchJobs({ providerId: 'greenhouse', boardKey: 'acme', boardUrl: '' });
    expect(result.outcome === 'JOBS' && result.jobs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- Lever

const leverJob = (n: number, extra: object = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  text: `Role ${n}`,
  categories: {
    commitment: 'Regular Full Time (Salary)',
    department: 'Customer Success',
    location: 'Remote - Pakistan',
    allLocations: ['Remote - Pakistan', 'Lahore'],
    team: 'CS',
  },
  country: 'PK',
  workplaceType: 'hybrid',
  descriptionPlain: 'Great role',
  lists: [{ text: 'Requirements:', content: '<li>3 years</li><li>SQL</li>' }],
  additionalPlain: 'We are an equal opportunity employer',
  hostedUrl: `https://jobs.lever.co/acme/${n}`,
  applyUrl: `https://jobs.lever.co/acme/${n}/apply`,
  createdAt: 1788199939703,
  ...extra,
});

describe('LeverProvider', () => {
  it.each([
    ['https://jobs.lever.co/acme', 'acme', undefined],
    ['https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000001', 'acme', undefined],
    ['https://jobs.eu.lever.co/acme', 'acme', 'eu'],
    ['https://api.lever.co/v0/postings/acme?mode=json', 'acme', undefined],
    ['https://api.eu.lever.co/v0/postings/acme', 'acme', 'eu'],
  ])('identifies %s', (url, site, region) => {
    const p = new LeverProvider(options(mockFetch(() => json([])).fn));
    const board = p.identify(url);
    expect(board).toMatchObject({ providerId: 'lever', boardKey: site });
    expect(board?.region).toBe(region);
  });

  it('does not identify look-alikes', () => {
    const p = new LeverProvider(options(mockFetch(() => json([])).fn));
    expect(p.identify('https://jobs.lever.co.evil.com/acme')).toBeNull();
    expect(p.identify('https://lever.co/acme')).toBeNull();
    expect(p.identify('https://jobs.lever.co/')).toBeNull();
  });

  it('pages with skip/limit until a short page, and normalizes', async () => {
    const all = Array.from({ length: 230 }, (_, i) => leverJob(i + 1));
    const m = mockFetch((url) => {
      const skip = Number(new URL(url).searchParams.get('skip'));
      const limit = Number(new URL(url).searchParams.get('limit'));
      return json(all.slice(skip, skip + limit));
    });
    const p = new LeverProvider(options(m.fn));
    const result = await p.fetchJobs(p.identify('https://jobs.lever.co/acme')!);

    expect(m.calls.map((c) => new URL(c.url).searchParams.get('skip'))).toEqual([
      '0',
      '100',
      '200',
    ]);
    expect(m.calls[0]!.url).toContain(
      'https://api.lever.co/v0/postings/acme?mode=json&skip=0&limit=100',
    );
    expect(result).toMatchObject({ outcome: 'JOBS', pagesFetched: 3, authoritative: true });
    if (result.outcome !== 'JOBS') return;
    expect(result.jobs).toHaveLength(230);
    expect(result.jobs[0]).toMatchObject({
      externalId: '00000000-0000-4000-8000-000000000001',
      title: 'Role 1',
      location: 'Remote - Pakistan',
      locations: ['Remote - Pakistan', 'Lahore'],
      department: 'Customer Success',
      employmentType: 'FULL_TIME',
      workplaceType: 'HYBRID',
      applicationUrl: 'https://jobs.lever.co/acme/1/apply',
      sourceUrl: 'https://jobs.lever.co/acme/1',
    });
    expect(result.jobs[0]!.publishedAt?.getTime()).toBe(1788199939703);
    expect(result.jobs[0]!.description).toContain('Great role');
    expect(result.jobs[0]!.description).toContain('SQL');
  });

  it('uses the EU instance for EU boards', async () => {
    const m = mockFetch(() => json([leverJob(1)]));
    const p = new LeverProvider(options(m.fn));
    await p.fetchJobs(p.identify('https://jobs.eu.lever.co/acme')!);
    expect(m.calls[0]!.url).toMatch(/^https:\/\/api\.eu\.lever\.co\/v0\/postings\/acme/);
  });

  it('a failure on page 2 is FAILED with the partial jobs, never a complete list', async () => {
    const m = mockFetch((_u, n) =>
      n === 0 ? json(Array.from({ length: 100 }, (_, i) => leverJob(i + 1))) : json({}, 502),
    );
    const p = new LeverProvider(options(m.fn));
    const result = await p.fetchJobs(p.identify('https://jobs.lever.co/acme')!);
    expect(result).toMatchObject({
      outcome: 'FAILED',
      pagesFetched: 1,
      error: { retryable: true, httpStatus: 502 },
    });
    expect(result.outcome === 'FAILED' && result.jobs).toHaveLength(100);
  });

  it('empty list is NO_OPENINGS; 404 is a missing board, not zero jobs', async () => {
    const p = new LeverProvider(options(mockFetch(() => json([])).fn));
    const board = p.identify('https://jobs.lever.co/acme')!;
    expect(await p.fetchJobs(board)).toMatchObject({ outcome: 'NO_OPENINGS', authoritative: true });
    const missing = new LeverProvider(
      options(mockFetch(() => json({ ok: false, error: 'Document not found' }, 404)).fn),
    );
    expect(await missing.fetchJobs(board)).toMatchObject({
      outcome: 'FAILED',
      error: { code: 'BOARD_NOT_FOUND' },
    });
    const wrongShape = new LeverProvider(options(mockFetch(() => json({ not: 'an array' })).fn));
    expect(await wrongShape.fetchJobs(board)).toMatchObject({
      outcome: 'FAILED',
      error: { code: 'BAD_RESPONSE' },
    });
  });

  it('rate-limits each request on the API host', async () => {
    const { limiter, hosts } = spyLimiter();
    const m = mockFetch((url) =>
      json(
        new URL(url).searchParams.get('skip') === '0'
          ? Array.from({ length: 100 }, (_, i) => leverJob(i + 1))
          : [],
      ),
    );
    const p = new LeverProvider(options(m.fn, limiter));
    await p.fetchJobs(p.identify('https://jobs.lever.co/acme')!);
    expect(hosts).toEqual(['api.lever.co', 'api.lever.co']);
  });
});

// ---------------------------------------------------------------- Ashby

const ashbyJob = (n: number, extra: object = {}) => ({
  id: `a-${n}`,
  title: `Designer ${n}`,
  location: 'Houston, TX',
  secondaryLocations: [{ location: 'San Francisco', address: {} }],
  department: 'Product',
  team: 'Growth',
  isListed: true,
  isRemote: false,
  workplaceType: 'OnSite',
  employmentType: 'FullTime',
  descriptionHtml: '<p>Join <b>us</b></p>',
  descriptionPlain: 'Join us',
  publishedAt: '2021-04-30T16:21:55.393+00:00',
  jobUrl: `https://jobs.ashbyhq.com/acme/a-${n}`,
  applyUrl: `https://jobs.ashbyhq.com/acme/a-${n}/application`,
  ...extra,
});

describe('AshbyProvider', () => {
  it('identifies boards', () => {
    const p = new AshbyProvider(options(mockFetch(() => json({})).fn));
    expect(p.identify('https://jobs.ashbyhq.com/acme')).toMatchObject({
      providerId: 'ashby',
      boardKey: 'acme',
    });
    expect(p.identify('https://jobs.ashbyhq.com/acme/a-1/application')).toMatchObject({
      boardKey: 'acme',
    });
    expect(p.identify('https://api.ashbyhq.com/posting-api/job-board/acme')).toMatchObject({
      boardKey: 'acme',
    });
    expect(p.identify('https://jobs.ashbyhq.com/')).toBeNull();
    expect(p.identify('https://ashbyhq.com.evil.io/acme')).toBeNull();
  });

  it('fetches, skips unlisted jobs, and normalizes', async () => {
    const m = mockFetch(() =>
      json({
        apiVersion: '1',
        jobs: [
          ashbyJob(1),
          ashbyJob(2, { isListed: false }),
          ashbyJob(3, {
            workplaceType: 'Remote',
            employmentType: 'Intern',
            secondaryLocations: [],
          }),
        ],
      }),
    );
    const p = new AshbyProvider(options(m.fn));
    const result = await p.fetchJobs(p.identify('https://jobs.ashbyhq.com/acme')!);
    expect(m.calls[0]!.url).toBe('https://api.ashbyhq.com/posting-api/job-board/acme');
    expect(result).toMatchObject({ outcome: 'JOBS', authoritative: true });
    if (result.outcome !== 'JOBS') return;
    expect(result.jobs.map((j) => j.externalId)).toEqual(['a-1', 'a-3']);
    expect(result.jobs[0]).toMatchObject({
      title: 'Designer 1',
      locations: ['Houston, TX', 'San Francisco'],
      department: 'Product',
      employmentType: 'FULL_TIME',
      workplaceType: 'ONSITE',
      description: 'Join us',
      applicationUrl: 'https://jobs.ashbyhq.com/acme/a-1/application',
      sourceUrl: 'https://jobs.ashbyhq.com/acme/a-1',
    });
    expect(result.jobs[0]!.publishedAt?.toISOString()).toBe('2021-04-30T16:21:55.393Z');
    expect(result.jobs[1]).toMatchObject({ employmentType: 'INTERNSHIP', workplaceType: 'REMOTE' });
  });

  it('falls back to the URL for the id (documented sample has none) and handles empty / failing boards', async () => {
    const { id: _id, ...noId } = ashbyJob(9);
    const p = new AshbyProvider(options(mockFetch(() => json({ jobs: [noId] })).fn));
    const board = { providerId: 'ashby', boardKey: 'acme', boardUrl: '' };
    const result = await p.fetchJobs(board);
    expect(result.outcome === 'JOBS' && result.jobs[0]!.externalId).toBe('a-9');

    expect(
      await new AshbyProvider(options(mockFetch(() => json({ jobs: [] })).fn)).fetchJobs(board),
    ).toMatchObject({ outcome: 'NO_OPENINGS' });
    expect(
      await new AshbyProvider(
        options(mockFetch(() => json({ jobs: [ashbyJob(1, { isListed: false })] })).fn),
      ).fetchJobs(board),
    ).toMatchObject({ outcome: 'NO_OPENINGS' });
    expect(
      await new AshbyProvider(
        options(mockFetch(() => new Response('Not Found', { status: 404 })).fn),
      ).fetchJobs(board),
    ).toMatchObject({ outcome: 'FAILED', error: { code: 'BOARD_NOT_FOUND' } });
    expect(
      await new AshbyProvider(options(mockFetch(() => json({}, 500)).fn)).fetchJobs(board),
    ).toMatchObject({ outcome: 'FAILED', error: { retryable: true } });
  });
});

// ---------------------------------------------------------------- registry + detection

describe('registry and ATS detection', () => {
  const f = options(mockFetch(() => json({})).fn);
  const registry = new JobProviderRegistry([
    new GreenhouseProvider(f),
    new LeverProvider(f),
    new AshbyProvider(f),
    new GenericHtmlJobProvider({
      fetchText: async () => {
        throw new Error('unused');
      },
    }),
  ]);
  const ats = new ATSDetectionService(registry);

  it('registry routes URLs to the right adapter and rejects duplicates', () => {
    expect(registry.identify('https://jobs.lever.co/acme')?.provider.id).toBe('lever');
    expect(registry.identify('https://boards.greenhouse.io/acme')?.provider.id).toBe('greenhouse');
    expect(registry.identify('https://jobs.ashbyhq.com/acme')?.provider.id).toBe('ashby');
    expect(registry.identify('https://acme.com/careers')).toBeNull();
    expect(registry.all().map((p) => p.id)).toEqual([
      'greenhouse',
      'lever',
      'ashby',
      'generic-html',
    ]);
    expect(() => registry.register(new LeverProvider(f))).toThrow(/already registered/);
  });

  it('identifies supported and unsupported platforms from URLs', () => {
    expect(ats.detectFromUrl('https://jobs.lever.co/acme')).toMatchObject({
      platform: 'lever',
      supported: true,
    });
    expect(ats.detectFromUrl('https://apply.workable.com/acme/')).toMatchObject({
      platform: 'workable',
      supported: false,
    });
    expect(ats.detectFromUrl('https://acme.bamboohr.com/careers')).toMatchObject({
      platform: 'bamboohr',
      supported: false,
    });
    expect(ats.detectFromUrl('https://acme.com/careers')).toBeNull();
    expect(ats.detectFromUrl('https://bamboohr.com.evil.io/')).toBeNull();
  });

  it('finds ATS boards embedded in a page, without running it', () => {
    const html = `<html><body>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
      <iframe src="https://jobs.ashbyhq.com/acme-co/embed"></iframe>
      <script>var cfg = {"url":"https:\\/\\/x.com","lever":"https://jobs.eu.lever.co/acme-eu"};</script>
      <a href="https://apply.workable.com/acme/">Jobs</a></body></html>`;
    const found = ats.detectFromHtml(html);
    expect(found.map((d) => `${d.platform}:${d.board?.boardKey ?? '-'}`).sort()).toEqual([
      'ashby:acme-co',
      'greenhouse:acme',
      'lever:acme-eu',
      'workable:-',
    ]);
    expect(found.find((d) => d.platform === 'lever')?.board?.region).toBe('eu');
    expect(found.every((d) => d.evidence === 'EMBED')).toBe(true);
  });
});
