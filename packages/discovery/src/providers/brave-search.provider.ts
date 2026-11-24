import { ProviderError } from '../errors';
import { fetchJson, type FetchLike } from '../http';
import { countryNameOf } from '../normalization/company-normalization.service';
import { foldText, stripLegalSuffixes, tokenize } from '../normalization/text';
import { isAggregatorDomain, normalizeWebsite } from '../normalization/website';
import type {
  CompanyCandidate,
  CompanyDiscoveryProvider,
  DiscoveryPage,
  DiscoveryProjectInput,
  DiscoveryQuery,
  ProviderRateLimit,
  ProviderTerms,
  SearchContext,
} from '../types';

export interface BraveSearchOptions {
  apiKey: string;
  baseUrl?: string;
  /** Requests per second allowed by your Brave plan (free tier: 1). */
  requestsPerSecond?: number;
  /** Result pages per keyword (20 results each; Brave allows offsets 0-9). */
  pagesPerQuery?: number;
  fetchImpl?: FetchLike;
}

interface BraveResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
}

const TITLE_SEPARATORS = /\s+[|\-–—·•:]\s+|\s*\|\s*/;
const BOILERPLATE =
  /^(home|homepage|welcome( to)?|official( site| website)?|about( us)?|contact( us)?)$/i;

/**
 * Web-search based discovery through the Brave Search API.
 *
 * LICENSING: Brave's terms bar storing/caching results unless the plan grants storage
 * rights. We persist derived candidates (name + homepage + provenance), so this provider
 * is only created when the operator explicitly confirms such a plan (see createProviders).
 */
export class BraveSearchProvider implements CompanyDiscoveryProvider {
  readonly id = 'brave-search';
  readonly displayName = 'Brave Search API';
  readonly terms: ProviderTerms = {
    termsUrl: 'https://api-dashboard.search.brave.com/terms-of-service',
    reviewedAt: '2026-11-24',
    storage: 'PERMANENT',
    bulkAllowed: false,
    notes:
      'Storage of results requires a plan with storage rights (operator-confirmed). Results are pages, not companies: only company-like homepages are kept.',
  };
  readonly rateLimit: ProviderRateLimit;
  /** A web hit carries no guarantee about the company's city. */
  readonly cityScoped = false;

  private readonly baseUrl: string;
  private readonly pages: number;

  constructor(private readonly options: BraveSearchOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.search.brave.com/res/v1/web/search';
    this.pages = Math.min(Math.max(options.pagesPerQuery ?? 2, 1), 10);
    this.rateLimit = {
      maxRequests: Math.max(options.requestsPerSecond ?? 1, 1),
      perMs: 1000,
      concurrency: 1,
    };
  }

  planQueries(project: DiscoveryProjectInput): DiscoveryQuery[] {
    return project.keywords.map((keyword) => ({
      kind: 'KEYWORD' as const,
      key: `kw:${foldText(keyword)}`,
      keyword,
      project,
    }));
  }

  async search(
    query: DiscoveryQuery,
    cursor: string | undefined,
    context?: SearchContext,
  ): Promise<DiscoveryPage> {
    if (!query.keyword) {
      throw new ProviderError('Brave search needs a keyword', 'BAD_REQUEST', { retryable: false });
    }
    const page = cursor ? Number.parseInt(cursor, 10) : 0;
    if (!Number.isInteger(page) || page < 0 || page >= this.pages) {
      throw new ProviderError('Invalid cursor', 'BAD_REQUEST', { retryable: false });
    }

    const { city, country } = query.project;
    const url = new URL(this.baseUrl);
    url.searchParams.set('q', `${query.keyword} ${city} ${countryNameOf(country)}`);
    url.searchParams.set('country', country);
    url.searchParams.set('count', '20');
    url.searchParams.set('offset', String(page));
    url.searchParams.set('safesearch', 'moderate');

    const json = (await fetchJson(url.toString(), {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.options.apiKey },
      signal: context?.signal,
      fetchImpl: this.options.fetchImpl,
      defaultRetryAfterMs: 1500,
    })) as { web?: { results?: unknown } };

    const results = json?.web?.results;
    if (results !== undefined && !Array.isArray(results)) {
      throw new ProviderError('Unexpected Brave response shape', 'BAD_RESPONSE', {
        retryable: false,
      });
    }

    const retrievedAt = new Date();
    const candidates: CompanyCandidate[] = [];
    let filtered = 0;
    for (const result of (results ?? []) as BraveResult[]) {
      const candidate = this.toCandidate(result, query.keyword, retrievedAt);
      if (candidate) candidates.push(candidate);
      else filtered += 1;
    }

    const exhausted = (results as unknown[] | undefined)?.length === 0;
    const next = page + 1;
    return {
      candidates,
      filtered,
      nextCursor: !exhausted && next < this.pages ? String(next) : undefined,
    };
  }

  /**
   * A search hit is a *page*. Keep it as a company candidate only when it looks like the
   * company's own site: not a directory/social/job-board domain and not a deep article URL.
   * Everything kept is low-confidence on the name and unverified on the website.
   */
  private toCandidate(
    result: BraveResult,
    keyword: string,
    retrievedAt: Date,
  ): CompanyCandidate | undefined {
    if (typeof result.url !== 'string' || typeof result.title !== 'string') return undefined;
    const website = normalizeWebsite(result.url);
    if (!website || isAggregatorDomain(website.domain)) return undefined;

    let pathSegments: number;
    try {
      pathSegments = new URL(result.url).pathname.split('/').filter(Boolean).length;
    } catch {
      return undefined;
    }
    if (pathSegments > 2) return undefined; // deep page: article / listing, not a homepage

    const { name, confidence } = nameFromTitle(result.title, website.domain);
    if (!name) return undefined;

    return {
      providerId: this.id,
      name,
      nameConfidence: confidence,
      websiteUrl: website.url,
      description:
        typeof result.description === 'string' ? stripTags(result.description) : undefined,
      sourceUrl: result.url,
      matchedKeyword: keyword,
      retrievedAt,
      raw: { title: result.title, url: result.url },
    };
  }
}

export function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * Derive a company name from a page title ("Arbisoft | Software House in Lahore").
 * Prefers the title segment that resembles the domain; otherwise falls back to the domain
 * label. Returns LOW confidence unless the segment clearly matches the domain.
 */
export function nameFromTitle(
  title: string,
  domain: string,
): { name: string; confidence: 'HIGH' | 'LOW' } {
  const label = domain.split('.')[0] ?? domain;
  // Compare without corporate-form words on either side: "Systems Limited" ≈ systemsltd.com.
  const labelKey = foldText(label)
    .replace(/ /g, '')
    .replace(/(ltd|limited|pvt|inc|llc)$/, '');
  const segments = title
    .split(TITLE_SEPARATORS)
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter((segment) => segment.length > 0 && !BOILERPLATE.test(segment));

  const matching = segments.find((segment) => {
    const key = stripLegalSuffixes(tokenize(foldText(segment))).join('');
    return (
      labelKey.length >= 3 && key.length >= 3 && (key.includes(labelKey) || labelKey.includes(key))
    );
  });
  if (matching && matching.length <= 80) return { name: matching, confidence: 'HIGH' };

  const fallback = label
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return { name: fallback, confidence: 'LOW' };
}
