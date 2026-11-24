import { describe, expect, it, vi } from 'vitest';
import {
  OverpassProvider,
  ProviderError,
  type DiscoveryProjectInput,
  type FetchLike,
} from '../src';

const project: DiscoveryProjectInput = {
  country: 'PK',
  city: 'Lahore',
  industry: 'Software Development',
  keywords: ['Software House', 'IT Company'],
};

const options = { userAgent: 'JobFinderTest/1.0 (test)' };

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** Answers the area-resolution query ("out ids") and the search query like Overpass would. */
const overpass = (elements: unknown[], areas: number[] = [16117666, 16117507]) =>
  vi.fn<FetchLike>(async (_url, init) => {
    const ql = decodeURIComponent(String(init?.body).replace(/^data=/, ''));
    return ql.includes('out ids;')
      ? json({ elements: areas.map((id) => ({ type: 'relation', id })) })
      : json({ elements });
  });

describe('OverpassProvider', () => {
  it('plans an area query for software industries plus one query per keyword', () => {
    const provider = new OverpassProvider(options);
    expect(provider.planQueries(project).map((q) => q.key)).toEqual([
      'area:industry',
      'kw:software house',
      'kw:it company',
    ]);
    expect(provider.planQueries({ ...project, industry: 'Textiles' }).map((q) => q.kind)).toEqual([
      'KEYWORD',
      'KEYWORD',
    ]);
  });

  it('resolves the city by English name with administrative suffixes (Lahore District / City Tehsil)', () => {
    const ql = new OverpassProvider(options).buildAreaQuery(project);
    expect(ql).toContain('["ISO3166-1"="PK"]');
    // matches `name` OR `name:en`, case-insensitively
    expect(ql).toContain('[~"^name(:en)?$"~"^Lahore( (city|district|');
    expect(ql).toContain('out ids;');

    // Regression: Lahore has no relation named exactly "Lahore" (found by a live run).
    const regex =
      /^Lahore( (city|district|municipality|municipal corporation|metropolitan corporation|metropolis|town))?( tehsil)?$/i;
    for (const name of ['Lahore', 'Lahore District', 'Lahore City Tehsil']) {
      expect(name).toMatch(regex);
    }
    for (const name of ['Lahore Division', 'Lahore Cantonment Tehsil', 'New Lahore']) {
      expect(name).not.toMatch(regex);
    }
  });

  it('builds a city-scoped search from resolved area ids and sanitizes injected characters', () => {
    const provider = new OverpassProvider(options);
    const ql = provider.buildQuery(
      { kind: 'KEYWORD', key: 'k', keyword: 'Soft"; out;//ware', project },
      [16117666, 16117507],
    );
    // Regression (found live): an id list needs the `id:` prefix or Overpass answers HTTP 400.
    expect(ql).toContain('rel(id:16117666,16117507);');
    expect(ql).not.toMatch(/rel\(\d/);
    expect(ql).toContain('map_to_area->.a;');
    expect(ql).not.toMatch(/"; out;/);
    expect(ql).toContain('out center tags 400;');
    expect(() => provider.buildQuery({ kind: 'AREA', key: 'a', project }, [])).toThrow(
      ProviderError,
    );

    const hostile = provider.buildAreaQuery({ ...project, city: 'La"hore]' });
    expect(hostile).toContain('^La[ -]?hore(');
    expect(hostile).not.toContain(']"');
  });

  it('fails loudly (non-retryable) when the city cannot be resolved', async () => {
    const provider = new OverpassProvider({ ...options, fetchImpl: overpass([], []) });
    await expect(
      provider.search(provider.planQueries(project)[0]!, undefined),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      retryable: false,
      message: expect.stringContaining('was not found in OpenStreetMap'),
    });
  });

  it('parses elements into candidates with provenance and keeps sparse ones', async () => {
    const fetchImpl = overpass([
      {
        type: 'node',
        id: 1,
        lat: 31.5,
        lon: 74.3,
        tags: {
          name: 'Systems Limited',
          office: 'it',
          website: 'https://www.systemsltd.com/',
          phone: '+92 42 111 797 836',
          'addr:street': 'Main Boulevard',
          'addr:housenumber': '9',
          'addr:suburb': 'Gulberg',
          'ref:ntn': '1234567-8',
        },
      },
      {
        type: 'way',
        id: 2,
        center: { lat: 31.4, lon: 74.2 },
        tags: { name: 'Bare Bones Soft', office: 'company' },
      },
      { type: 'node', id: 3, tags: { office: 'it' } },
      { type: 'node', id: 4, tags: { name: 'Closed Co', office: 'it', 'disused:office': 'it' } },
    ]);
    const provider = new OverpassProvider({ ...options, fetchImpl });
    expect(provider.cityScoped).toBe(true);
    const page = await provider.search(provider.planQueries(project)[0]!, undefined);

    expect(page.candidates).toHaveLength(2);
    expect(page.filtered).toBe(2);
    expect(page.candidates[0]).toMatchObject({
      providerId: 'overpass-osm',
      externalId: 'node/1',
      name: 'Systems Limited',
      websiteUrl: 'https://www.systemsltd.com/',
      sourceUrl: 'https://www.openstreetmap.org/node/1',
      coordinates: { lat: 31.5, lng: 74.3 },
      registrationNumbers: [{ scheme: 'NTN', value: '1234567-8' }],
    });
    expect(page.candidates[1]).toMatchObject({ externalId: 'way/2', name: 'Bare Bones Soft' });
    expect(page.candidates[1]!.websiteUrl).toBeUndefined();

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['User-Agent']).toBe(options.userAgent);
  });

  it('caches both the area resolution and the results', async () => {
    const store = new Map<string, string>();
    const cache = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
    };
    const fetchImpl = overpass([]);
    const provider = new OverpassProvider({ ...options, cache, fetchImpl });
    const q = provider.planQueries(project)[1]!;
    await provider.search(q, undefined);
    await provider.search(q, undefined);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 resolve + 1 search, then all from cache
    expect(store.size).toBe(2);
  });

  it('honours a 30s default pause on 429 and reports runtime errors as retryable', async () => {
    const limited = new OverpassProvider({
      ...options,
      fetchImpl: async () => new Response('', { status: 429 }),
    });
    await expect(limited.search(limited.planQueries(project)[0]!, undefined)).rejects.toMatchObject(
      {
        code: 'RATE_LIMITED',
        options: { retryAfterMs: 30_000 },
      },
    );

    const runtime = new OverpassProvider({
      ...options,
      fetchImpl: async (_url, init) =>
        decodeURIComponent(String(init?.body)).includes('out ids;')
          ? json({ elements: [{ type: 'relation', id: 5 }] })
          : json({ elements: [], remark: 'runtime error: Query timed out' }),
    });
    await expect(runtime.search(runtime.planQueries(project)[0]!, undefined)).rejects.toMatchObject(
      {
        code: 'UNAVAILABLE',
        retryable: true,
      },
    );
  });
});
