/** DI tokens for the enrichment module (tests override these with fakes). */
export const ENRICHMENT_PROVIDER = Symbol('ENRICHMENT_PROVIDER');
/** The shared SSRF-guarded, robots-aware, rate-limited page fetcher (used by enrichment and jobs). */
export const PAGE_FETCHER = Symbol('PAGE_FETCHER');
export const WEBSITE_CANDIDATE_FINDER = Symbol('WEBSITE_CANDIDATE_FINDER');

/** An enrichment failure worth retrying (site unreachable, timeouts, 5xx). */
export class RetryableEnrichmentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RetryableEnrichmentError';
  }
}
