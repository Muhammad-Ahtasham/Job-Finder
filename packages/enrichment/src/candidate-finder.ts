import {
  fetchJson,
  isAggregatorDomain,
  normalizeWebsite,
  type FetchLike,
} from '@jobfinder/discovery';
import type { EnrichmentContext, WebsiteCandidateFinder } from './types';

export interface BraveCandidateFinderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Candidates returned per company; each costs one verification fetch. */
  maxCandidates?: number;
}

/**
 * Proposes websites for companies that have none, using the Brave Search API. Results are
 * only CANDIDATES: each one is still verified against the company's name and city before it
 * is accepted. As with discovery, the operator must hold a plan with storage rights, so the
 * worker only builds this finder under the same conditions as the Brave discovery provider.
 */
export class BraveWebsiteCandidateFinder implements WebsiteCandidateFinder {
  readonly id = 'brave-search';

  constructor(private readonly options: BraveCandidateFinderOptions) {}

  async findCandidates(
    input: { companyName: string; city?: string | null; country?: string },
    context: EnrichmentContext = {},
  ): Promise<string[]> {
    const url = new URL(this.options.baseUrl ?? 'https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', `"${input.companyName}" ${input.city ?? ''} official website`.trim());
    if (input.country) url.searchParams.set('country', input.country);
    url.searchParams.set('count', '10');

    const body = (await fetchJson(url.href, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.options.apiKey },
      signal: context.signal,
      fetchImpl: this.options.fetchImpl,
    })) as { web?: { results?: { url?: unknown }[] } };

    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const result of body.web?.results ?? []) {
      const site = normalizeWebsite(typeof result.url === 'string' ? result.url : undefined);
      if (!site || isAggregatorDomain(site.domain) || seen.has(site.domain)) continue;
      seen.add(site.domain);
      candidates.push(site.url);
      if (candidates.length >= (this.options.maxCandidates ?? 3)) break;
    }
    return candidates;
  }
}
