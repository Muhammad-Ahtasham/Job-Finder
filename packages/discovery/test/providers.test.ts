import { describe, expect, it, vi } from 'vitest';
import {
  BraveSearchProvider,
  createProviders,
  nameFromTitle,
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

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('BraveSearchProvider', () => {
  const braveBody = {
    web: {
      results: [
        {
          title: 'Arbisoft | Software House in Lahore',
          url: 'https://www.arbisoft.com/',
          description: '<b>Best</b> team',
        },
        {
          title: 'Top 50 Software Houses in Lahore - Clutch',
          url: 'https://clutch.co/pk/developers/lahore',
        },
        { title: 'Lahore IT firms - LinkedIn', url: 'https://www.linkedin.com/company/arbisoft' },
        {
          title: 'Dawn: IT sector grows',
          url: 'https://www.dawn.com/news/123456/it-sector-grows-in-lahore',
        },
        { title: 'Welcome', url: 'https://folio3.com/about' },
        { title: 'Blog post', url: 'https://someblog.pk/a/b/c/d' },
      ],
    },
  };

  it('plans one query per keyword', () => {
    const provider = new BraveSearchProvider({ apiKey: 'k' });
    expect(provider.planQueries(project).map((q) => q.keyword)).toEqual([
      'Software House',
      'IT Company',
    ]);
  });

  it('calls the documented endpoint with auth header and scoped query', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(braveBody));
    const provider = new BraveSearchProvider({ apiKey: 'secret-key', fetchImpl });
    const [query] = provider.planQueries(project);
    await provider.search(query!, undefined);

    const [url, init] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(parsed.searchParams.get('q')).toBe('Software House Lahore Pakistan');
    expect(parsed.searchParams.get('country')).toBe('PK');
    expect(parsed.searchParams.get('count')).toBe('20');
    expect((init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('secret-key');
  });

  it('keeps company homepages and filters directories, social, news and deep pages', async () => {
    const provider = new BraveSearchProvider({
      apiKey: 'k',
      fetchImpl: async () => json(braveBody),
    });
    const page = await provider.search(provider.planQueries(project)[0]!, undefined);

    expect(page.candidates.map((c) => c.websiteUrl)).toEqual([
      'https://arbisoft.com/',
      'https://folio3.com/',
    ]);
    expect(page.filtered).toBe(4);
    const arbisoft = page.candidates[0]!;
    expect(arbisoft).toMatchObject({
      name: 'Arbisoft',
      nameConfidence: 'HIGH',
      providerId: 'brave-search',
    });
    expect(arbisoft.description).toBe('Best team');
    // "Welcome" is boilerplate: the name falls back to the domain with LOW confidence.
    expect(page.candidates[1]).toMatchObject({ name: 'Folio3', nameConfidence: 'LOW' });
  });

  it('paginates up to the configured pages', async () => {
    const provider = new BraveSearchProvider({
      apiKey: 'k',
      pagesPerQuery: 2,
      fetchImpl: async () => json(braveBody),
    });
    const q = provider.planQueries(project)[0]!;
    expect((await provider.search(q, undefined)).nextCursor).toBe('1');
    expect((await provider.search(q, '1')).nextCursor).toBeUndefined();
    await expect(provider.search(q, '5')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps HTTP failures to retryable / fatal provider errors', async () => {
    const make = (status: number, headers: Record<string, string> = {}) =>
      new BraveSearchProvider({
        apiKey: 'k',
        fetchImpl: async () => new Response('x', { status, headers }),
      });
    const q = make(200).planQueries(project)[0]!;

    await expect(make(429, { 'retry-after': '7' }).search(q, undefined)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      options: { retryable: true, retryAfterMs: 7000 },
    });
    await expect(make(503).search(q, undefined)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryable: true,
    });
    await expect(make(401).search(q, undefined)).rejects.toMatchObject({
      code: 'AUTH',
      retryable: false,
    });
    await expect(make(402).search(q, undefined)).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
      retryable: false,
    });
  });

  it('treats network failure as a retryable error', async () => {
    const provider = new BraveSearchProvider({
      apiKey: 'k',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(
      provider.search(provider.planQueries(project)[0]!, undefined),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('derives names from titles', () => {
    expect(nameFromTitle('Systems Limited - Digital Transformation', 'systemsltd.com')).toEqual({
      name: 'Systems Limited',
      confidence: 'HIGH',
    });
    expect(nameFromTitle('Home', 'my-company.pk')).toEqual({
      name: 'My Company',
      confidence: 'LOW',
    });
  });
});

describe('createProviders (licence gating)', () => {
  it('enables OSM without credentials', () => {
    const { providers } = createProviders({ enabled: ['overpass-osm'], userAgent: 'ua' });
    expect(providers.map((p) => p.id)).toEqual(['overpass-osm']);
  });

  it('refuses Brave without a key or without confirmed storage rights', () => {
    const noKey = createProviders({ enabled: ['brave-search'], userAgent: 'ua' });
    expect(noKey.providers).toHaveLength(0);
    expect(noKey.skipped[0]!.reason).toMatch(/API_KEY/);

    const noRights = createProviders({
      enabled: ['brave-search'],
      userAgent: 'ua',
      brave: { apiKey: 'k' },
    });
    expect(noRights.providers).toHaveLength(0);
    expect(noRights.skipped[0]!.reason).toMatch(/storage/i);

    const ok = createProviders({
      enabled: ['brave-search', 'overpass-osm'],
      userAgent: 'ua',
      brave: { apiKey: 'k', storageRightsConfirmed: true },
    });
    expect(ok.providers.map((p) => p.id).sort()).toEqual(['brave-search', 'overpass-osm']);
  });

  it('does not implement Google Places or Foursquare', () => {
    const { providers, skipped } = createProviders({
      enabled: ['google-places', 'foursquare'],
      userAgent: 'ua',
    });
    expect(providers).toHaveLength(0);
    expect(skipped.map((s) => s.reason)).toEqual(['unknown provider id', 'unknown provider id']);
  });
});
